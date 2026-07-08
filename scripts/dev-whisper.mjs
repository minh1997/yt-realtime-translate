import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const apiDir = join(process.cwd(), 'whisper-api');
const pythonPath = process.platform === 'win32'
  ? join(apiDir, '.venv', 'Scripts', 'python.exe')
  : join(apiDir, '.venv', 'bin', 'python');

const command = existsSync(pythonPath) ? pythonPath : 'python';
const args = [
  '-m',
  'uvicorn',
  'app.main:app',
  '--host',
  '127.0.0.1',
  '--port',
  '8787',
  '--reload',
];

const child = spawn(command, args, {
  cwd: apiDir,
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  }

  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(`Failed to start Whisper API: ${error.message}`);
  process.exit(1);
});
