import { CAMERA_TESTS } from './cameraTests';
import { LINK_TESTS } from './linkTests';
import { MOTION_TESTS } from './motionTests';
import { SENSOR_TESTS } from './sensorTests';
import type { TestDefinition } from './types';

export const ALL_TESTS: TestDefinition[] = [...LINK_TESTS, ...SENSOR_TESTS, ...MOTION_TESTS, ...CAMERA_TESTS];

export function testById(id: string): TestDefinition | undefined {
  return ALL_TESTS.find((t) => t.id === id);
}
