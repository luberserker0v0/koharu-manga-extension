import { describe, expect, it } from 'vitest';
import { isSupportedSourceImage, moveSourceFile, prepareSourceFiles } from '../lib/domain/source-files';

function file(name: string, type = ''): File {
  return new File(['image'], name, { type });
}

describe('source file preparation', () => {
  it('accepts supported image formats and rejects disguised files', () => {
    expect(isSupportedSourceImage(file('page-1.png', 'image/png'))).toBe(true);
    expect(isSupportedSourceImage(file('page-2.jpg'))).toBe(true);
    expect(isSupportedSourceImage(file('notes.txt', 'text/plain'))).toBe(false);
    expect(isSupportedSourceImage(file('fake.png', 'text/plain'))).toBe(false);
  });

  it('sorts accepted files in natural numeric order and reports rejected files', () => {
    const result = prepareSourceFiles([file('10.jpg'), file('bad.pdf'), file('2.jpg'), file('1.jpg')]);
    expect(result.accepted.map((item) => item.name)).toEqual(['1.jpg', '2.jpg', '10.jpg']);
    expect(result.rejected.map((item) => item.name)).toEqual(['bad.pdf']);
  });

  it('supports explicit pre-upload reordering', () => {
    const files = [file('1.jpg'), file('2.jpg'), file('3.jpg')];
    expect(moveSourceFile(files, 2, -1).map((item) => item.name)).toEqual(['1.jpg', '3.jpg', '2.jpg']);
  });
});
