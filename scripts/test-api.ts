/* eslint-disable no-console */
/**
 * Orchestrates a Playwright suite against a disposable Compose stack:
 *
 *   1. docker compose up (builds the umami image, starts Postgres [+ ClickHouse or a mock OIDC provider])
 *   2. waits for /api/heartbeat
 *   3. runs Playwright against the container: the API suite (tests/api,
 *      playwright.api.config.ts), or with --e2e the browser suite (tests/e2e,
 *      playwright.config.ts)
 *   4. dumps container logs on failure
 *   5. tears the stack down (unless --keep)
 *
 * Usage: tsx scripts/test-api.ts [options] [-- playwright args]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisposableTarget } from '../tests/api/paths';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = 'docker-compose.test.yml';
// Read before parseArgs because the stack identity below depends on it. The e2e
// suite gets its own project and port: it replaces the admin password, which
// would break the API suite (it logs in with the default) on a shared stack.
// --oidc runs the browser suite against a stack with a mock OpenID Connect provider.
const OIDC = process.argv.slice(2).includes('--oidc');
const E2E = OIDC || process.argv.slice(2).includes('--e2e');
const PROJECT_NAME =
  process.env.COMPOSE_PROJECT_NAME ||
  (OIDC ? 'umami-e2e-oidc-test' : E2E ? 'umami-e2e-test' : 'umami-api-test');
const PORT = process.env.UMAMI_TEST_PORT || (OIDC ? '3300' : E2E ? '3200' : '3100');
// docker-compose.test.yml publishes the app on UMAMI_TEST_PORT and the provider on
// UMAMI_TEST_OIDC_PORT.
process.env.UMAMI_TEST_PORT = PORT;
const OIDC_PORT = process.env.UMAMI_TEST_OIDC_PORT || '3390';
process.env.UMAMI_TEST_OIDC_PORT = OIDC_PORT;
// The Compose service name of the provider, which tests/e2e/oidc.spec.ts resolves in the browser.
const OIDC_HOST = 'oidc-idp';
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${PORT}`;
// PLAYWRIGHT_BASE_URL selects an already-running server: no Compose stack is
// built, started, or torn down for it.
const EXTERNAL_TARGET = !!process.env.PLAYWRIGHT_BASE_URL;
const HEARTBEAT_TIMEOUT_MS = 180_000;
const DOWN_COMMAND = OIDC
  ? 'pnpm test:e2e:docker:oidc --down'
  : E2E
    ? 'pnpm test:e2e:docker --down'
    : 'pnpm test:api:down';
// Mirrors RUNTIME_DIR in tests/api/paths.ts (one state dir per target host).
const LOG_FILE = path.join(
  ROOT_DIR,
  'tests/api/.runtime',
  new URL(BASE_URL).host.replace(/[^a-z0-9.-]+/gi, '-'),
  'docker.log',
);

const HELP = `
Usage: pnpm test:api [options] [-- playwright args]
       pnpm test:e2e:docker [options] [-- playwright args]
       pnpm test:e2e:docker:oidc [options] [-- playwright args]

Options:
  --e2e               Run the browser suite (tests/e2e) instead of the API suite.
                      Uses its own stack (project umami-e2e-test, port 3200)
  --oidc              Run the browser suite with OIDC sign-in configured against a mock
                      provider, which enables tests/e2e/oidc.spec.ts. Implies --e2e.
                      Uses its own stack (project umami-e2e-oidc-test, port 3300)
  --clickhouse        Run against Postgres + ClickHouse (analytics stored in ClickHouse)
  --keep              Leave the containers running after the tests finish
  --no-build          Skip the image build (use the existing UMAMI_TEST_IMAGE)
  --up-only           Start the stack, wait for readiness, and exit (see --keep)
  --down              Tear down the stack and exit
  --grep <expr>       Only run matching tests (implies --coverage-report)
  --coverage-report   Print endpoint coverage without failing the run (API suite only)
  -h, --help          Show this help

Environment:
  UMAMI_TEST_PORT     Host port for the app (default 3100, 3200 with --e2e, 3300 with --oidc)
  UMAMI_TEST_OIDC_PORT  Host port for the mock OIDC provider (default 3390)
  UMAMI_TEST_IMAGE    Image tag to build/run (default umami-test:local)
  COMPOSE_PROJECT_NAME  Compose project name (default umami-api-test, umami-e2e-test or
                      umami-e2e-oidc-test)
  PLAYWRIGHT_BASE_URL  Test an already-running server instead of starting the
                      Compose stack (pass --clickhouse if it stores analytics there)
  API_ALLOW_DESTRUCTIVE=1  Required for non-loopback PLAYWRIGHT_BASE_URL targets: the suite
                      recreates websites, ingests data and toggles global 2FA
  API_SKIP_SEED=1     Reuse the previous seed when re-running against a kept stack
                      (each run seeds additively otherwise)
`;

interface Options {
  e2e: boolean;
  oidc: boolean;
  clickhouse: boolean;
  keep: boolean;
  build: boolean;
  upOnly: boolean;
  down: boolean;
  grep?: string;
  coverageReport: boolean;
  passthrough: string[];
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    e2e: false,
    oidc: false,
    clickhouse: false,
    keep: false,
    build: true,
    upOnly: false,
    down: false,
    coverageReport: false,
    passthrough: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      options.passthrough.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--grep=')) {
      options.grep = arg.slice('--grep='.length);
      continue;
    }

    switch (arg) {
      case '--e2e':
        options.e2e = true;
        break;
      case '--oidc':
        options.oidc = true;
        options.e2e = true;
        break;
      case '--clickhouse':
        options.clickhouse = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--no-build':
        options.build = false;
        break;
      case '--up-only':
        options.upOnly = true;
        break;
      case '--down':
        options.down = true;
        break;
      case '--coverage-report':
        options.coverageReport = true;
        break;
      case '--grep':
        options.grep = argv[++i];
        break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        console.log(HELP);
        process.exit(2);
    }
  }

  return options;
}

function run(command: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

function capture(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });

  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function composeArgs(profiles: string[], args: string[]) {
  return [
    'compose',
    '-f',
    COMPOSE_FILE,
    '-p',
    PROJECT_NAME,
    ...profiles.flatMap(profile => ['--profile', profile]),
    ...args,
  ];
}

// Docker reports a taken host port as an opaque "ports are not available" error
// after the image has already been built, so check up front. Probe by connecting
// rather than binding: on Windows a second listen() on a busy port can succeed
// unless the owner set SO_EXCLUSIVEADDRUSE, so a bind test gives false negatives.
function isPortFree(port: number) {
  return new Promise<boolean>(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (free: boolean) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

async function waitForHeartbeat(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/heartbeat`);

      if (response.ok) {
        return;
      }

      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for ${url}/api/heartbeat (${lastError})`);
}

// The Compose profiles in docker-compose.test.yml: the app service of each, and the services
// whose logs a failed run prints.
const STACKS = {
  postgres: { appService: 'umami', logServices: ['umami', 'db'] },
  clickhouse: {
    appService: 'umami-clickhouse',
    logServices: ['umami-clickhouse', 'db', 'clickhouse'],
  },
  oidc: { appService: 'umami-oidc', logServices: ['umami-oidc', 'db', 'oidc-idp'] },
};

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.oidc && options.clickhouse) {
    console.error('--oidc runs against Postgres only and cannot be combined with --clickhouse.');
    return 2;
  }

  const profile = options.oidc ? 'oidc' : options.clickhouse ? 'clickhouse' : 'postgres';
  const { appService, logServices } = STACKS[profile];

  const teardown = () => {
    console.log('\nStopping test stack...');
    run('docker', composeArgs(Object.keys(STACKS), ['down', '-v', '--remove-orphans']));
  };

  if (EXTERNAL_TARGET && (options.upOnly || options.down)) {
    console.error(
      'PLAYWRIGHT_BASE_URL selects an already-running server; --up-only and --down manage ' +
        'the local Compose stack and cannot be combined with it.',
    );
    return 2;
  }

  if (options.down) {
    teardown();
    return 0;
  }

  const dumpLogs = () => {
    const logs = capture('docker', composeArgs([profile], ['logs', '--no-color', ...logServices]));

    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    writeFileSync(LOG_FILE, logs);

    console.log(`\n--- docker compose logs (${logServices.join(', ')}) ---\n`);
    console.log(logs);
    console.log(`--- end of logs (saved to ${path.relative(ROOT_DIR, LOG_FILE)}) ---\n`);
  };

  let exitCode = 1;
  let started = false;

  const onSignal = () => {
    console.log('\nInterrupted.');

    if (started && !options.keep) {
      teardown();
    }

    process.exit(130);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    if (EXTERNAL_TARGET) {
      try {
        assertDisposableTarget(BASE_URL);
      } catch (error) {
        console.error((error as Error).message);
        return 2;
      }
      console.log(`Using the already-running server at ${BASE_URL} (PLAYWRIGHT_BASE_URL is set).`);
    } else {
      // A kept stack from a previous run legitimately owns the port; only
      // complain when something else is listening on it.
      const ownStackRunning = capture(
        'docker',
        composeArgs([profile], ['ps', '-q', '--status', 'running', appService]),
      ).trim();

      if (!ownStackRunning && !(await isPortFree(Number(PORT)))) {
        console.error(
          `Port ${PORT} is already in use on this machine, so the umami container cannot be published there.
` +
            `Stop whatever is listening on ${PORT} (e.g. another dev server), or pick a different port:
` +
            `  UMAMI_TEST_PORT=3200 pnpm test:api`,
        );
        return 2;
      }

      if (options.oidc && !ownStackRunning && !(await isPortFree(Number(OIDC_PORT)))) {
        console.error(
          `Port ${OIDC_PORT} is already in use on this machine, so the mock OIDC provider cannot ` +
            'be published there.\nPick a different port: UMAMI_TEST_OIDC_PORT=3391 pnpm test:e2e:docker:oidc',
        );
        return 2;
      }

      console.log(`Starting test stack (profile: ${profile}, port: ${PORT})...`);

      const upArgs = ['up', '-d', '--wait', '--wait-timeout', '300'];

      if (options.build) {
        upArgs.push('--build');
      }

      started = true;

      if (run('docker', composeArgs([profile], upArgs)) !== 0) {
        console.error('docker compose up failed.');
        dumpLogs();
        return 1;
      }
    }

    await waitForHeartbeat(BASE_URL, HEARTBEAT_TIMEOUT_MS);

    console.log(`umami is ready at ${BASE_URL}`);

    // tests/e2e/oidc.spec.ts runs only when it knows the provider's host name.
    const oidcEnv = options.oidc ? { UMAMI_TEST_OIDC_HOST: OIDC_HOST } : {};

    if (options.upOnly) {
      options.keep = true;
      console.log(
        options.e2e
          ? `\nRun tests with: PLAYWRIGHT_BASE_URL=${BASE_URL} PLAYWRIGHT_SKIP_WEB_SERVER=1 ` +
              (options.oidc ? `UMAMI_TEST_OIDC_HOST=${OIDC_HOST} ` : '') +
              'pnpm test:e2e' +
              `\nStop the stack with: ${DOWN_COMMAND}`
          : `\nRun tests with: PLAYWRIGHT_BASE_URL=${BASE_URL} UMAMI_TEST_DB=${profile} pnpm test:api:run` +
              '\nRe-running against the same stack? Add API_SKIP_SEED=1 (seeding is additive).' +
              `\nStop the stack with: ${DOWN_COMMAND}`,
      );
      return 0;
    }

    // Invoke the Playwright CLI through the current node binary instead of
    // `pnpm exec`: on Windows that resolves to pnpm.cmd, which Node refuses to
    // spawn without a shell (EINVAL, CVE-2024-27980 hardening).
    const playwrightCli = path.join(
      path.dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json')),
      'cli.js',
    );
    const playwrightArgs = [
      playwrightCli,
      'test',
      '-c',
      options.e2e ? 'playwright.config.ts' : 'playwright.api.config.ts',
    ];

    if (options.grep) {
      playwrightArgs.push('--grep', options.grep);
    }

    playwrightArgs.push(...options.passthrough);

    // The container is the server under test, so Playwright must not start `pnpm dev`.
    const target = { PLAYWRIGHT_BASE_URL: BASE_URL, PLAYWRIGHT_SKIP_WEB_SERVER: '1' };

    exitCode = run(
      process.execPath,
      playwrightArgs,
      options.e2e
        ? { ...target, ...oidcEnv }
        : {
            ...target,
            UMAMI_TEST_DB: profile,
            API_COVERAGE:
              process.env.API_COVERAGE ??
              (options.grep || options.coverageReport ? 'report' : 'enforce'),
          },
    );

    if (exitCode !== 0 && started) {
      dumpLogs();
    }

    if (exitCode !== 0 && options.e2e) {
      console.log(
        'Failure screenshots and traces are in test-results/.' +
          '\nOpen the report with: pnpm exec playwright show-report',
      );
    }

    return exitCode;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);

    if (started && !options.keep) {
      teardown();
    } else if (started) {
      console.log(`\nStack left running (${BASE_URL}). Stop it with: ${DOWN_COMMAND}`);
    }
  }
}

main()
  .then(code => {
    process.exit(code);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
