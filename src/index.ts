import semver from 'semver'
import path from 'path'
import { parse } from 'parse-package-name'
import { _import, _importRelative, _resolve, _resolveRelative } from './utils.js'
import { execaCommand } from 'execa'
import validateNpmName from 'validate-npm-package-name'

type Logger = (message: string) => void

type Package = {
  name: string
  packageWithPath: string
  version: string
  path: string
  imported: typeof NOT_IMPORTABLE | any
  local: boolean
}

const NOT_IMPORTABLE = Symbol()
const INSTALLED_LOCALLY = Symbol()
const INSTALL_CACHE: Record<string, string | typeof INSTALLED_LOCALLY> = {}

export async function npxImport<T = unknown>(
  pkg: string | string[],
  logger: Logger = (message: string) => console.log(`[NPXI] ${message}`)
): Promise<T> {
  const packages = await checkPackagesAvailableLocally(pkg)
  const allPackages = Object.values(packages)
  const localPackages = allPackages.filter((p) => p.imported !== NOT_IMPORTABLE)
  const missingPackages = allPackages.filter((p) => p.imported === NOT_IMPORTABLE)

  if (missingPackages.length > 0) {
    logger(
      `${
        missingPackages.length > 1
          ? `Packages ${missingPackages.map((p) => p.packageWithPath).join(', ')}`
          : missingPackages[0].packageWithPath
      } not available locally. Attempting to use npx to install temporarily.`
    )
    try {
      await checkNpxVersion()
      const installDir = await installAndReturnDir(missingPackages, logger)
      for (const pkg of missingPackages) {
        packages[pkg.name].imported = await _importRelative(installDir, pkg.packageWithPath)
        INSTALL_CACHE[pkg.name] = installDir
      }
      for (const pkg of localPackages) {
        INSTALL_CACHE[pkg.name] = INSTALLED_LOCALLY
      }
    } catch (e) {
      throw new Error(
        `npx-import failed for ${missingPackages
          .map((p) => p.packageWithPath)
          .join(',')} with message:\n    ${e.message}\n\n` +
          `You should install ${missingPackages.map((p) => p.name).join(', ')} locally: \n    ` +
          installInstructions(missingPackages) +
          `\n\n`
      )
    }
  }

  const results = allPackages.map((p) => p.imported)
  // If you pass in an array, you get an array back.
  return Array.isArray(pkg) ? results : results[0]
}

export function npxResolve(pkg: string): string {
  const { name, path } = parse(pkg)
  const packageWithPath = [name, path].join('')
  const cachedDir = INSTALL_CACHE[name]
  if (!cachedDir) {
    throw new Error(`You must call npxImport for a package before calling npxResolve. Got: ${pkg}`)
  } else if (cachedDir === INSTALLED_LOCALLY) {
    return _resolve(packageWithPath)
  } else {
    return _resolveRelative(cachedDir, packageWithPath)
  }
}

async function checkPackagesAvailableLocally(pkg: string | string[]) {
  const packages: Record<string, Package> = {}

  for (const p of Array.isArray(pkg) ? pkg : [pkg]) {
    const { name, version, path } = parseAndValidate(p)
    if (packages[name])
      throw new Error(
        `npx-import cannot import the same package twice! Got: '${p}' but already saw '${name}' earlier!`
      )
    const packageWithPath = [name, path].join('')
    const imported = await tryImport(packageWithPath)
    packages[name] = {
      name,
      packageWithPath,
      version,
      path,
      imported,
      local: imported !== NOT_IMPORTABLE,
    }
  }
  return packages
}

function parseAndValidate(p: string) {
  if (p.match(/^[.\/]/)) {
    throw new Error(`npx-import can only import packages, not relative paths: got ${p}`)
  }
  const { name, version, path } = parse(p)
  const validation = validateNpmName(name)
  if (!validation.validForNewPackages) {
    if (validation.warnings?.some((w) => w.match(/is a core module name/)))
      throw new Error(
        `npx-import can only import NPM packages, got core module '${name}' from '${p}'`
      )
    else
      throw new Error(
        `npx-import can't import invalid package name: parsed name '${name}' from '${p}'`
      )
  }
  return { name, version, path }
}

async function tryImport(packageWithPath: string) {
  try {
    return await _import(packageWithPath)
  } catch (e) {
    return NOT_IMPORTABLE
  }
}

async function checkNpxVersion() {
  const versionCmd = `npx --version`
  const { failed, stdout: npmVersion } = await execaCommand(versionCmd)
  if (failed) {
    throw new Error(`Couldn't execute ${versionCmd}. Is npm installed and up-to-date?`)
  }

  if (!semver.gte(npmVersion, '8.0.0')) {
    throw new Error(`Require npm version 8+. Got '${npmVersion}' when running '${versionCmd}'`)
  }
}

async function installAndReturnDir(packages: Package[], logger: Logger) {
  const installPackage = `npx -y ${packages.map((p) => `-p ${formatForCLI(p)}`).join(' ')}`
  logger(`Installing... (${installPackage})`)
  const emitPath = `node -e 'console.log(process.env.PATH)'`
  const fullCmd = `${installPackage} ${emitPath}`
  const { failed, stdout } = await execaCommand(fullCmd, {
    shell: true,
  })
  if (failed) {
    throw new Error(
      `Failed installing ${packages.map((p) => p.name).join(',')} using: ${installPackage}.`
    )
  }
  const paths = stdout.split(':')
  const tempPath = paths.find((p) => /\/\.npm\/_npx\//.exec(p))

  if (!tempPath)
    throw new Error(
      `Failed to find temporary install directory. Looking for paths matching '/.npm/_npx/' in:\n${JSON.stringify(
        paths
      )}`
    )

  // Expecting the path ends with node_modules/.bin
  const nodeModulesPath = path.resolve(tempPath, '..')
  if (!nodeModulesPath.endsWith('node_modules')) {
    throw new Error(
      `Found NPX temporary path of '${tempPath}' but expected to be able to find a node_modules directory by looking in '..'.`
    )
  }

  logger(`Installed into ${nodeModulesPath}.`)
  logger(`To skip this step in future, run: ${installInstructions(packages)}`)

  return nodeModulesPath
}

const INSTRUCTIONS = {
  npm: (packageName: string) => `npm install --save-dev ${packageName}`,
  pnpm: (packageName: string) => `pnpm add -D ${packageName}`,
  yarn: (packageName: string) => `yarn add -D ${packageName}`,
}
function installInstructions(packages: Package[]) {
  return INSTRUCTIONS[getPackageManager()](packages.map(formatForCLI).join(' '))
}

export function getPackageManager(): keyof typeof INSTRUCTIONS {
  const userAgent = process.env.npm_config_user_agent
  if (userAgent) {
    if (userAgent.startsWith('pnpm')) return 'pnpm'
    if (userAgent.startsWith('yarn')) return 'yarn'
    if (userAgent.startsWith('npm')) return 'npm'
  }

  const execpath = process.env.npm_execpath
  if (execpath) {
    if (/np[xm]-cli\.js$/.exec(execpath)) return 'npm'
    if (/yarn$/.exec(execpath)) return 'yarn'
  }

  const mainModulePath = process.mainModule?.path
  if (mainModulePath) {
    if (/\/\.?pnpm\//.exec(mainModulePath)) return 'pnpm'
    if (/\/\.?yarn\//.exec(mainModulePath)) return 'yarn'
  }

  return 'npm'
}

// If the version contains special chars, wrap in ''
const formatForCLI = (p) => {
  const unescaped = `${p.name}@${p.version}`
  return unescaped.match(/[<>*]/) ? `'${unescaped}'` : unescaped
}
