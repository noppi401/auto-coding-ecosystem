import { spawn, ChildProcess } from 'child_process';

type Platform = NodeJS.Platform;
type SpawnUrl = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;

export interface OpenUrlCommand {
  command: string;
  args: string[];
}

export function getOpenExternalUrlCommand(url: string, platform: Platform = process.platform): OpenUrlCommand {
  validateHttpUrl(url);

  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', 'Start-Process -FilePath $args[0]', url],
    };
  }

  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }

  return { command: 'xdg-open', args: [url] };
}

export function openExternalUrl(url: string, spawnUrl: SpawnUrl = spawn): Promise<void> {
  const command = getOpenExternalUrlCommand(url);

  return new Promise((resolve, reject) => {
    const child = spawnUrl(command.command, command.args, {
      stdio: 'ignore',
      windowsHide: true,
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command.command} exited with code ${code}`));
      }
    });
  });
}

function validateHttpUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
}
