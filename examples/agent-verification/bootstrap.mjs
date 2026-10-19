/** Own child only: let Playwright receive SIGINT inside Node on Windows too. */
import { pathToFileURL } from 'node:url';
let requested = false;
let sent = false;
const timer = setInterval(() => {
  if (requested && !sent && process.listenerCount('SIGINT') > 0) { sent = true; process.emit('SIGINT'); }
}, 25);
timer.unref();
process.on('message', value => { if (value === 'testlane:verification:cancel:v1') requested = true; });
process.on('disconnect', () => { requested = true; });
const [cli, config] = process.argv.slice(2);
process.argv = [process.execPath, cli, 'test', '--config', config, '--workers=1', '--retries=0'];
await import(pathToFileURL(cli));
process.channel?.unref();
