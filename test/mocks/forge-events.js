/**
 * Minimal mock of @forge/events: records every pushed event in `pushedEvents`.
 */
export const pushedEvents = [];

export function resetEvents() {
  pushedEvents.length = 0;
}

export class Queue {
  constructor({ key }) {
    this.key = key;
  }

  async push(events) {
    for (const event of Array.isArray(events) ? events : [events]) pushedEvents.push({ queue: this.key, ...event });
    return { jobId: 'job-1' };
  }
}
