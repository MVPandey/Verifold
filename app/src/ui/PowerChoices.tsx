import type { ReactElement } from 'react';

import type { Power } from '../api/types.ts';
import { POWER_WORDS } from '../model/coordinator.ts';

const ORDER: readonly Power[] = ['time', 'permissions', 'agents', 'settings', 'question', 'pace'];

/**
 * The powers that the person can switch on for the coordinator's seat when they set the seat up. Each one is off
 * until the person ticks it, and the panel for the coordinator switches it later.
 */
export function PowerChoices(props: {
  readonly value: readonly Power[];
  readonly onChange: (powers: readonly Power[]) => void;
}): ReactElement {
  return (
    <fieldset className="k-setup">
      <legend>What the coordinator may do without asking you</legend>
      {ORDER.map((power) => (
        <label className="check" key={power}>
          <input
            type="checkbox"
            checked={props.value.includes(power)}
            onChange={(event) =>
              props.onChange(
                ORDER.filter((one) =>
                  one === power ? event.target.checked : props.value.includes(one),
                ),
              )
            }
          />
          {POWER_WORDS[power].name}
        </label>
      ))}
      <p className="note">
        Without a tick, the coordinator asks you first. Stopping the lab stays with you.
      </p>
    </fieldset>
  );
}
