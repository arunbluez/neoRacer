import { describe, expect, it } from 'vitest';
import { applyMotor, cmd, cmdName, isQuery, wireLength } from './commands';
import { LineSplitter, parseReply } from './parser';
import { decodeAscii, encodeAscii } from './ascii';

describe('command builders', () => {
  it('builds every command the firmware knows', () => {
    expect(cmd.forward()).toBe('F');
    expect(cmd.forward(50)).toBe('F');
    expect(cmd.forward(80)).toBe('F,80');
    expect(cmd.backward(70)).toBe('B,70');
    expect(cmd.left(40)).toBe('L,40');
    expect(cmd.right()).toBe('R');
    expect(cmd.forward(0)).toBe('F,1'); // speeds for F/B/L/R are 1..100
    expect(cmd.forward(250)).toBe('F,100');
    expect(cmd.stop()).toBe('S');
    expect(cmd.motorLeft(75)).toBe('ML,75');
    expect(cmd.motorRight(-40)).toBe('MR,-40');
    expect(cmd.motors(-40.4, 140)).toBe('MS,-40,100');
    expect(cmd.headlights({ r: 255, g: 0, b: 300 })).toBe('HL,255,0,255');
    expect(cmd.headlightLeft({ r: 255, g: 165, b: 0 })).toBe('HLL,255,165,0');
    expect(cmd.headlightRight({ r: 1, g: 2, b: 3 })).toBe('HLR,1,2,3');
    expect(cmd.lightsOff()).toBe('HO');
    expect(cmd.underglow({ r: 0, g: 255, b: 0 })).toBe('UG,0,255,0');
    expect(cmd.underglowLeft({ r: 0, g: 0, b: 255 })).toBe('UGL,0,0,255');
    expect(cmd.underglowRight({ r: 255, g: 0, b: 255 })).toBe('UGR,255,0,255');
    expect(cmd.underglowOff()).toBe('UGO');
    expect(cmd.horn()).toBe('HORN');
    expect(cmd.beep()).toBe('BEEP');
    expect(cmd.tone(440, 500)).toBe('TONE,440,500');
    expect(cmd.quiet()).toBe('QUIET');
    expect(cmd.mute()).toBe('MUTE');
    expect(cmd.display('HI#THERE')).toBe('DISP,HITHERE');
    expect(cmd.icon('HAPPY')).toBe('ICON,HAPPY');
    expect(cmd.cls()).toBe('CLS');
    expect([cmd.dist(), cmd.line(), cmd.compass(), cmd.accel(), cmd.light(), cmd.temp(), cmd.ping()])
      .toEqual(['?DIST', '?LINE', '?COMPASS', '?ACCEL', '?LIGHT', '?TEMP', 'PING']);
  });

  it('names, queries and wire length', () => {
    expect(cmdName('MS,1,2')).toBe('MS');
    expect(cmdName(' HL ,1,2,3')).toBe('HL');
    expect(isQuery('?LINE')).toBe(true);
    expect(isQuery('PING')).toBe(true);
    expect(isQuery('HORN')).toBe(false);
    expect(wireLength('MS,-100,-100')).toBe(13);
  });

  it('tracks motor state like the firmware', () => {
    let s = { l: 0, r: 0 };
    s = applyMotor('F', s);
    expect(s).toEqual({ l: 50, r: 50 });
    s = applyMotor('ML,20', s);
    expect(s).toEqual({ l: 20, r: 50 });
    s = applyMotor('MR,-10', s);
    expect(s).toEqual({ l: 20, r: -10 });
    expect(applyMotor('L,30', s)).toEqual({ l: -30, r: 30 });
    expect(applyMotor('R', s)).toEqual({ l: 50, r: -50 });
    expect(applyMotor('B,70', s)).toEqual({ l: -70, r: -70 });
    expect(applyMotor('MS,5', s)).toEqual(s); // malformed: ignored
    expect(applyMotor('S', s)).toEqual({ l: 0, r: 0 });
  });
});

describe('reply parser', () => {
  it('parses every reply type', () => {
    expect(parseReply('DIST:42')).toEqual({ type: 'dist', cm: 42 });
    expect(parseReply('LINE:3')).toEqual({ type: 'line', code: 3 });
    expect(parseReply('COMPASS:359')).toEqual({ type: 'compass', degrees: 359 });
    expect(parseReply('ACCEL:-12,4,-1024')).toEqual({ type: 'accel', x: -12, y: 4, z: -1024 });
    expect(parseReply('LIGHT:128')).toEqual({ type: 'light', level: 128 });
    expect(parseReply('TEMP:23')).toEqual({ type: 'temp', celsius: 23 });
    expect(parseReply('PONG')).toEqual({ type: 'pong' });
    expect(parseReply(' PONG ')).toEqual({ type: 'pong' });
  });

  it('reports garbled and unknown replies as raw', () => {
    expect(parseReply('LINE:7')).toEqual({ type: 'raw', text: 'LINE:7' });
    expect(parseReply('LINE:')).toEqual({ type: 'raw', text: 'LINE:' });
    expect(parseReply('ACCEL:1,2')).toEqual({ type: 'raw', text: 'ACCEL:1,2' });
    expect(parseReply('DIST:4x')).toEqual({ type: 'raw', text: 'DIST:4x' });
    expect(parseReply('PONGPONG')).toEqual({ type: 'raw', text: 'PONGPONG' });
    expect(parseReply('HELLO:1')).toEqual({ type: 'raw', text: 'HELLO:1' });
  });

  it('reassembles partial chunks', () => {
    const s = new LineSplitter();
    expect(s.push('LI')).toEqual([]);
    expect(s.push('NE:')).toEqual([]);
    expect(s.push('2#')).toEqual(['LINE:2']);
    expect(s.push('\n')).toEqual([]);
    expect(s.pending).toBe('');
  });

  it('splits two replies in one chunk', () => {
    const s = new LineSplitter();
    expect(s.push('PONG#\nDIST:12#\n')).toEqual(['PONG', 'DIST:12']);
    expect(s.push('TEMP:2')).toEqual([]);
    expect(s.push('1#\nPO')).toEqual(['TEMP:21']);
    expect(s.push('NG#\n')).toEqual(['PONG']);
  });

  it('flushes runaway garbage', () => {
    const s = new LineSplitter(16);
    expect(s.push('x'.repeat(20))).toEqual(['x'.repeat(20)]);
  });
});

describe('ascii', () => {
  it('round trips and replaces non-ascii', () => {
    expect(decodeAscii(encodeAscii('MS,1,2#'))).toBe('MS,1,2#');
    expect(decodeAscii(encodeAscii('é'))).toBe('?');
  });
});
