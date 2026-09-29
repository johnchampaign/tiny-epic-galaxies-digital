import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('digital-boardgame-framework', async (importOriginal) => ({
  ...(await importOriginal<typeof import('digital-boardgame-framework')>()),
  recordPlay: vi.fn(async () => {}),
  recordFinish: vi.fn(async () => {}),
}));

import { recordFinish, recordPlay } from 'digital-boardgame-framework';
import { LocalEngine, type LocalSeat } from '../src/client/localEngine.js';

/** Force the engine into gameOver with the given winners (by seat index) and emit. */
function finish(engine: LocalEngine, winnerIdx: number[]): void {
  engine.state = { ...engine.state, phase: 'gameOver', winners: winnerIdx.map((i) => engine.state.order[i]) };
  (engine as unknown as { emit(): void }).emit();
}

const human = (name: string): LocalSeat => ({ name, control: 'human' });
const ai = (name: string): LocalSeat => ({ name, control: 'ai' });

describe('local play-counter beacons', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hotseat: finish fires once with the start mode and no outcome', () => {
    const e = new LocalEngine([human('A'), human('B')], 1, 1e9);
    expect(recordPlay).toHaveBeenCalledWith('tiny-epic-galaxies', 'hotseat');
    (e as unknown as { emit(): void }).emit(); // not over yet
    expect(recordFinish).not.toHaveBeenCalled();
    finish(e, [0]);
    finish(e, [0]); // re-emit / re-render of a finished game
    expect(recordFinish).toHaveBeenCalledTimes(1);
    expect(recordFinish).toHaveBeenCalledWith('tiny-epic-galaxies', 'hotseat');
    e.dispose();
  });

  it.each([
    [[0], 'win'],
    [[1], 'loss'],
    [[0, 1], 'draw'],
  ] as const)('vs AI: winners %j -> %s', (winners, outcome) => {
    const e = new LocalEngine([human('A'), ai('Bot')], 1, 1e9);
    finish(e, [...winners]);
    expect(recordFinish).toHaveBeenCalledTimes(1);
    expect(recordFinish).toHaveBeenCalledWith('tiny-epic-galaxies', 'ai', { outcome });
    e.dispose();
  });
});
