// Renders one text file to a WAV with Kokoro (kokoro-js). lucid copies this
// file next to the node_modules it installs, then runs it from there:
//
//   node kokoro.mjs <text file> <out.wav> [voice]
//
// The model is fetched once into ./hf-cache; later runs set OFFLINE=1.
import { readFile } from 'node:fs/promises'

import { RawAudio, env } from '@huggingface/transformers'
import { KokoroTTS, TextSplitterStream } from 'kokoro-js'

const [, , textFile, outFile, voice = 'af_heart'] = process.argv

if (!textFile || !outFile) {
  console.error('usage: node kokoro.mjs <text file> <out.wav> [voice]')
  process.exit(2)
}

env.cacheDir = new URL('./hf-cache/', import.meta.url).pathname
if (process.env.OFFLINE === '1') env.allowRemoteModels = false

const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' })

// One call voices only a few sentences, so the text goes through sentence by
// sentence and the pieces are joined into one clip.
const sentences = new TextSplitterStream()
sentences.push(await readFile(textFile, 'utf8'))
sentences.close()

const pieces = []
let rate = 24000
for await (const { audio } of tts.stream(sentences, { voice })) {
  pieces.push(audio.audio)
  rate = audio.sampling_rate
}

const samples = new Float32Array(pieces.reduce((total, piece) => total + piece.length, 0))
let at = 0
for (const piece of pieces) {
  samples.set(piece, at)
  at += piece.length
}

await new RawAudio(samples, rate).save(outFile)
console.log(JSON.stringify({ seconds: samples.length / rate, pieces: pieces.length }))
