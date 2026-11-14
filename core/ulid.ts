// ULIDs: sortable by time, so log ids also order entries.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom: number[] = [];

export function ulid(now = Date.now()): string {
  let random: number[];
  if (now === lastTime) {
    // Same millisecond: increment so ids stay strictly increasing.
    random = [...lastRandom];
    for (let i = random.length - 1; i >= 0; i--) {
      if (random[i]! < 31) {
        random[i]!++;
        break;
      }
      random[i] = 0;
    }
  } else {
    random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b % 32);
  }
  lastTime = now;
  lastRandom = random;
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  return time + random.map((r) => ALPHABET[r]).join("");
}
