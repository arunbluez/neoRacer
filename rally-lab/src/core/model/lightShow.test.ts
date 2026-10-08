import { describe, expect, it } from 'vitest';
import { AMBER, BRAKE_RED, healthColor, lightFrame, LightShow, markerAheadFor, speedColor } from './lightShow';

const GREEN = { r: 0, g: 255, b: 0 };

describe('light show', () => {
  it('signals the side it turns to, blinking, when driving', () => {
    const at = (t: number) => lightFrame({ mode: { kind: 'drive' }, t, l: 20, r: 45, braking: false, rttMs: 30, blinkMs: 500 })!;
    // Right wheel faster: turning left.
    expect(at(0).hlL).toEqual(AMBER);
    expect(at(260).hlL).toEqual({ r: 0, g: 0, b: 0 });
    expect(at(0).hlR).toEqual({ r: 255, g: 255, b: 255 });
    const straight = lightFrame({ mode: { kind: 'drive' }, t: 0, l: 40, r: 42, braking: false, rttMs: 30, blinkMs: 500 })!;
    expect(straight.hlL).toEqual(straight.hlR);
    expect(straight.ug).toEqual(speedColor(41));
  });

  it('shows red when braking or reversing, and the link health standing still', () => {
    const brake = lightFrame({ mode: { kind: 'drive' }, t: 0, l: 20, r: 20, braking: true, rttMs: 30, blinkMs: 500 })!;
    expect(brake.hlL).toEqual(BRAKE_RED);
    const back = lightFrame({ mode: { kind: 'drive' }, t: 0, l: -30, r: -30, braking: false, rttMs: 30, blinkMs: 500 })!;
    expect(back.ug).toEqual(BRAKE_RED);
    const idle = lightFrame({ mode: { kind: 'drive' }, t: 0, l: 0, r: 0, braking: false, rttMs: 300, blinkMs: 500 })!;
    expect(idle.ug).toEqual(healthColor(300));
  });

  it('keeps the underglow in the marker colour during an auto run', () => {
    const f = lightFrame({ mode: { kind: 'auto', marker: GREEN }, t: 0, l: 0, r: 0, braking: false, rttMs: 30, blinkMs: 500, intent: { signal: 'R', brake: false, reverse: false } })!;
    expect(f.ug).toEqual(GREEN);
    expect(f.hlR).toEqual(AMBER);
    expect(f.hlL).toEqual(GREEN);
    expect(markerAheadFor(2, 3)).toBeCloseTo(3);
    expect(markerAheadFor(1, 3)).toBeCloseTo(2);
    expect(markerAheadFor(0, 3)).toBe(0);
  });

  it('sends only what changed, one command at a time, and lights the brakes on a slow-down', () => {
    const sent: string[] = [];
    const show = new LightShow((c) => sent.push(c));
    show.setMode({ kind: 'drive' }, 0);
    show.setMotor(40, 40, 0);
    for (let t = 0; t <= 400; t += 60) show.tick(t);
    expect(sent).toEqual(['HL,255,255,255', `UG,${Object.values(speedColor(40)).join(',')}`]);
    sent.length = 0;
    // Slowing from 40 to 15 (the drive loop repeats commands every ~300 ms): brake lights.
    show.setMotor(40, 40, 300);
    show.setMotor(15, 15, 500);
    show.tick(520);
    expect(sent[0]).toBe('HL,255,0,0');
    // Nothing more to say while nothing changes (after the underglow catches up).
    for (let t = 660; t <= 1100; t += 60) show.tick(t);
    const n = sent.length;
    for (let t = 1160; t <= 1150 + 300; t += 60) show.tick(t);
    expect(sent.length).toBe(n + 1); // the brake hold ends: headlights back to white
  });
});
