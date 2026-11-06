import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

/** Asks for a secret without showing what is typed or pasted, so it stays out of the screen and the shell's history. */
export async function askHidden(prompt: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<string> {
  output.write(prompt);
  const nowhere = new Writable({ write: (_chunk, _encoding, done) => done() });
  const reader = createInterface({ input, output: nowhere, terminal: true });
  try {
    return (await reader.question("")).trim();
  } finally {
    reader.close();
    output.write("\n");
  }
}
