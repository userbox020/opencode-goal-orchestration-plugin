import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUSTOM_SKILLS, type CustomSkill } from './custom-skills-registry';
import { getConfigDir } from './paths';

export { CUSTOM_SKILLS, type CustomSkill };

/**
 * Get the target directory for custom skills installation.
 */
export function getCustomSkillsDir(): string {
  return join(getConfigDir(), 'skills');
}

/**
 * Install a custom skill by copying from src/skills/ to the OpenCode skills directory
 * @param skill - The custom skill to install
 * @returns True if installation succeeded, false otherwise
 * @deprecated Use syncBundledSkillsFromPackage instead.
 */
export function installCustomSkill(skill: CustomSkill): boolean {
  console.warn(
    `[DEPRECATED] installCustomSkill is deprecated and will be removed. Use syncBundledSkillsFromPackage instead.`,
  );
  try {
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const sourceDir = join(packageRoot, skill.sourcePath);
    if (!existsSync(sourceDir)) return false;

    const targetDir = join(getCustomSkillsDir(), skill.name);
    mkdirSync(getCustomSkillsDir(), { recursive: true });
    cpSync(sourceDir, targetDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.error(
      `Failed to install custom skill safely: ${skill.name}`,
      error,
    );
    return false;
  }
}
