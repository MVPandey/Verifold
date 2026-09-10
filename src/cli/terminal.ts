import { stripVTControlCharacters } from 'node:util';

const logo = String.raw`    \\        /========
     \\      //          V E R I F O L D
      \\    /======
       \\  //
        \\//             Research beyond the paper plane.`;

/** Render terminal decoration only when stderr and input are interactive. */
export function terminalBanner(interactive: boolean, noColor: boolean): string {
  if (!interactive) return '';
  return `${noColor ? logo : `\u001b[38;5;141m${logo}\u001b[0m`}\n\n`;
}

/** Color prompt text without adding control codes when NO_COLOR is set. */
export function terminalPrompt(question: string, color: boolean): string {
  const plain = stripVTControlCharacters(question);
  return color ? `\u001b[38;5;141m${plain}\u001b[0m` : plain;
}
