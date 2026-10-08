import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../../../packages/foliate-js/', import.meta.url));
const patch = fileURLToPath(new URL('../../../patches/foliate-tts-highlight.patch', import.meta.url));
const applied = spawnSync('git', ['-C', directory, 'apply', '--reverse', '--check', patch], {
  stdio: 'ignore',
});
if (applied.status === 0) {
  console.log('Foliate TTS highlight patch already applied.');
} else {
  const result = spawnSync('git', ['-C', directory, 'apply', patch], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not apply the Foliate TTS highlight patch.');
  console.log('Applied Foliate TTS highlight patch.');
}
