import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGoalWorkflowFixture } from './goal-workflow-fixture';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distEntry = path.join(repoRoot, 'dist', 'index.js');
const hostVersion = process.env.OMOS_HOST_SMOKE_VERSION?.trim() || '1.18.29';

function fail(message: string): never {
  throw new Error(message);
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    fail(
      `Command failed: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`,
    );
  }

  return result.stdout.trim();
}

function parsePackJson(output: string) {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');

  if (start === -1 || end === -1 || end < start) {
    fail(`Could not locate npm pack JSON output:\n${output}`);
  }

  return JSON.parse(output.slice(start, end + 1)) as Array<{
    filename?: string;
  }>;
}

function packArtifact() {
  const output = run('npm', ['pack', '--json', '--ignore-scripts']);
  const parsed = parsePackJson(output);
  const tarball = parsed[0]?.filename;
  if (!tarball) fail(`npm pack did not return a tarball filename:\n${output}`);
  return path.join(repoRoot, tarball);
}

async function getFreePort() {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate free port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'health check did not succeed';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = `health check returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  fail(`OpenCode server did not become healthy: ${lastError}`);
}

function formatCapturedLogs(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  if (!combined) return 'No stdout/stderr captured.';

  const lines = combined.split(/\r?\n/);
  return lines.slice(-200).join('\n');
}

async function stopProcess(child: ReturnType<typeof spawn>) {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = await new Promise<boolean>((resolve) => {
      const finish = (result: boolean) => {
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve(result);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), 5000);
      child.once('exit', onExit);
      child.kill(signal);
    });
    if (exited) return;
  }
  fail('OpenCode smoke host did not terminate within the cleanup deadline');
}

function assertNoPluginLoadErrors(logs: string) {
  const badPatterns = [
    /failed to load plugin/i,
    /cannot find module/i,
    /error=.*failed to load plugin/i,
  ];

  const match = badPatterns.find((pattern) => pattern.test(logs));
  if (!match) return;

  const relevantLines = logs
    .split(/\r?\n/)
    .filter((line) =>
      /plugin|failed to load|cannot find module|error=/i.test(line),
    )
    .slice(-20)
    .join('\n');

  fail(
    `OpenCode logs contain plugin load errors:${relevantLines ? `\n${relevantLines}` : ''}`,
  );
}

function omitOpencodeEnv(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('OPENCODE_')),
  );
}

async function assertGoalCapability(baseUrl: string, directory: string) {
  const query = `directory=${encodeURIComponent(directory)}`;
  let lastError = 'agent endpoint was unavailable';
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    for (const route of ['/agent', '/api/agent']) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      try {
        const response = await fetch(`${baseUrl}${route}?${query}`, {
          signal: AbortSignal.timeout(Math.min(5_000, remainingMs)),
        });
        if (!response.ok) {
          lastError = `${route} returned ${response.status}`;
          continue;
        }
        const payload = (await response.json()) as unknown;
        const agents = Array.isArray(payload)
          ? payload
          : payload &&
              typeof payload === 'object' &&
              'data' in payload &&
              Array.isArray(payload.data)
            ? payload.data
            : undefined;
        if (!agents) {
          lastError = `${route} returned an unexpected response shape`;
          continue;
        }
        const goal = agents.find(
          (agent) =>
            agent &&
            typeof agent === 'object' &&
            (('name' in agent &&
              typeof agent.name === 'string' &&
              agent.name.toLowerCase() === 'goal') ||
              ('id' in agent &&
                typeof agent.id === 'string' &&
                agent.id.toLowerCase() === 'goal')),
        );
        if (!goal || typeof goal !== 'object') {
          lastError = `${route} did not expose Goal yet`;
          continue;
        }
        if (
          !('mode' in goal) ||
          goal.mode !== 'primary' ||
          ('hidden' in goal && goal.hidden === true)
        ) {
          fail('Packaged Goal must be an explicitly visible primary agent');
        }
        if (
          !('prompt' in goal) ||
          typeof goal.prompt !== 'string' ||
          !goal.prompt.includes('Goal verification:')
        ) {
          fail('Packaged Goal is missing its execution/verifier prompt');
        }
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  fail(`Could not verify packaged Goal capability: ${lastError}`);
}

function resolveOpencodeBin(hostDir: string) {
  const binDir = path.join(hostDir, 'node_modules', '.bin');
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(
            hostDir,
            'node_modules',
            'opencode-ai',
            'bin',
            'opencode.exe',
          ),
          path.join(binDir, 'opencode.exe'),
          path.join(binDir, 'opencode.cmd'),
        ]
      : [path.join(binDir, 'opencode')];

  for (const opencodeBin of candidates) {
    if (existsSync(opencodeBin)) return opencodeBin;
  }

  fail(`Expected opencode binary at ${candidates[0]}`);
}

async function verifyHostSmoke(tarballPath: string) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'omos-opencode-smoke-'));
  const homeDir = path.join(tempRoot, 'home');
  const configDir = path.join(tempRoot, 'config');
  const cacheDir = path.join(tempRoot, 'cache');
  const dataDir = path.join(tempRoot, 'data');
  const logDir = path.join(tempRoot, 'log');
  const hostDir = path.join(tempRoot, 'host');
  const workspaceDir = path.join(tempRoot, 'workspace');
  const tarballTarget = path.join(tempRoot, path.basename(tarballPath));
  const port = await getFreePort();
  const healthTimeoutMs = process.platform === 'darwin' ? 60_000 : 30_000;
  let fixture: Awaited<ReturnType<typeof startGoalWorkflowFixture>> | undefined;

  try {
    console.log('Packing plugin tarball into isolated test root...');
    copyFileSync(tarballPath, tarballTarget);

    for (const dir of [
      homeDir,
      configDir,
      cacheDir,
      dataDir,
      logDir,
      hostDir,
      workspaceDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(
      path.join(hostDir, 'package.json'),
      JSON.stringify(
        { name: 'verify-opencode-host-smoke', private: true },
        null,
        2,
      ),
    );

    console.log(
      `Installing opencode-ai@${hostVersion} into isolated test root...`,
    );
    run(
      'npm',
      [
        'install',
        '--no-save',
        '--no-package-lock',
        `opencode-ai@${hostVersion}`,
      ],
      {
        cwd: hostDir,
      },
    );

    const opencodeBin = resolveOpencodeBin(hostDir);
    console.log(
      `Installed host: ${run(opencodeBin, ['--version'], { cwd: hostDir })}`,
    );
    const opencodeBinNeedsShell =
      process.platform === 'win32' && opencodeBin.endsWith('.cmd');

    writeFileSync(
      path.join(configDir, 'package.json'),
      JSON.stringify(
        {
          type: 'module',
          dependencies: {
            'oh-my-opencode-slim': `file:${tarballTarget}`,
          },
        },
        null,
        2,
      ),
    );
    run('npm', ['install', '--ignore-scripts', '--no-package-lock'], {
      cwd: configDir,
    });
    const installedEntry = path.join(
      configDir,
      'node_modules',
      'oh-my-opencode-slim',
      'dist',
      'server.js',
    );
    const expectedHash = createHash('sha256')
      .update(readFileSync(path.join(repoRoot, 'dist', 'server.js')))
      .digest('hex');
    const installedHash = createHash('sha256')
      .update(readFileSync(installedEntry))
      .digest('hex');
    if (expectedHash !== installedHash)
      fail('Installed plugin does not match the packed server artifact');

    let pluginEntry = pathToFileURL(installedEntry).href;
    if (process.argv.includes('--workflow')) {
      fixture = await startGoalWorkflowFixture(workspaceDir);
      const wrapper = path.join(configDir, 'workflow-plugin.mjs');
      writeFileSync(
        wrapper,
        `import plugin from ${JSON.stringify(pluginEntry)};\nexport default { id: plugin.id, server: (input) => plugin.server({ ...input, __omosGoalPanelOpenBrowser: async (url) => { await fetch(${JSON.stringify(`${fixture.origin}/panel`)}, { method: 'POST', body: JSON.stringify({url}) }); } }) };\n`,
      );
      pluginEntry = pathToFileURL(wrapper).href;
      writeFileSync(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          agents: Object.fromEntries(
            [
              'orchestrator',
              'goal',
              'fixer',
              'explorer',
              'librarian',
              'oracle',
            ].map((name) => [name, { model: 'fixture/fixture' }]),
          ),
          backgroundJobs: {
            orchestratorWake: { enabled: true, intervalMs: 60_000 },
          },
          autoUpdate: false,
          disabled_mcps: ['context7', 'grep'],
        }),
      );
    }

    const config = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      plugin: [pluginEntry],
      ...(fixture
        ? {
            model: 'fixture/fixture',
            small_model: 'fixture/fixture',
            enabled_providers: ['fixture'],
            provider: {
              fixture: {
                npm: '@ai-sdk/openai-compatible',
                name: 'Isolated fixture',
                options: {
                  baseURL: `${fixture.origin}/v1`,
                  apiKey: 'fixture-not-a-secret',
                },
                models: {
                  fixture: {
                    name: 'Fixture',
                    limit: { context: 128000, output: 4096 },
                  },
                },
              },
            },
          }
        : {}),
    });

    const env = {
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_DATA_HOME: dataDir,
      OPENCODE_LOG_DIR: logDir,
      OPENCODE_TEST_HOME: homeDir,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_CONTENT: config,
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      ...(fixture
        ? { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true' }
        : {}),
    };

    console.log('Starting opencode serve with packaged plugin...');
    const child = spawn(
      opencodeBin,
      [
        'serve',
        '--print-logs',
        '--log-level',
        'DEBUG',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: workspaceDir,
        env: {
          ...omitOpencodeEnv(process.env),
          ...env,
        },
        shell: opencodeBinNeedsShell,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const exitPromise = new Promise<never>((_, reject) => {
      child.once('exit', (code, signal) => {
        reject(
          new Error(
            `opencode serve exited before smoke test completed (code=${code}, signal=${signal})\n${stdout}\n${stderr}`,
          ),
        );
      });
    });

    try {
      await Promise.race([
        waitForHealth(
          `http://127.0.0.1:${port}/global/health`,
          healthTimeoutMs,
        ),
        exitPromise,
      ]);

      await Promise.race([
        assertGoalCapability(`http://127.0.0.1:${port}`, workspaceDir),
        exitPromise,
      ]);
      if (fixture)
        await Promise.race([
          fixture.verify(`http://127.0.0.1:${port}`),
          exitPromise,
        ]);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assertNoPluginLoadErrors(`${stdout}\n${stderr}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(
        `${message}\nCaptured OpenCode logs:\n${formatCapturedLogs(stdout, stderr)}`,
      );
    } finally {
      // Always terminate the spawned server, including on the health-check
      // failure path where stopProcess would otherwise never be reached and
      // the child process would leak away after the temp dir is removed.
      await stopProcess(child);
    }
  } finally {
    await fixture?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function cleanupTarball(tarballPath: string) {
  rmSync(tarballPath, { force: true });
}

async function main() {
  if (!existsSync(distEntry)) {
    fail(
      'dist/index.js is missing. Run `bun run build` before verify:host-smoke.',
    );
  }

  const tarballPath = packArtifact();
  try {
    await verifyHostSmoke(tarballPath);
  } finally {
    cleanupTarball(tarballPath);
  }

  console.log('OpenCode host smoke verification passed.');
}

await main();
process.exit(0);
