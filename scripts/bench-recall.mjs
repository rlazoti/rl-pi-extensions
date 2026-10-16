import { parseTopicFile } from "../extensions/memory/schema.ts";
import { buildStore } from "../extensions/memory/resolver.ts";
import { inject, recall } from "../extensions/memory/inject.ts";

function makeStore(entries) {
  const files = [];
  for (let f = 0; f < entries; f += 25) {
    let text = `# topic ${f}\n`;
    for (let i = f; i < Math.min(f + 25, entries); i++) {
      text += `\n## topic${f}.claim${i}\n- kind: fact\n- scope: global\n- asOf: 2026-01-01\nThe ${"widget gadget module ".repeat(8)} behaviour number ${i} matters for ${i % 7 === 0 ? "caching" : "rendering"} decisions.\n`;
    }
    files.push(parseTopicFile(text, `knowledge/topic${f}.md`));
  }
  return buildStore(files);
}

for (const size of [50, 200, 1000, 5000]) {
  const store = makeStore(size);
  const query = "widget caching behaviour matters";
  const t0 = performance.now();
  const iterations = 200;
  let hits = 0;
  for (let i = 0; i < iterations; i++) hits += recall(store, query, 12).length;
  const t1 = performance.now();
  const r = inject(store, { query });
  const t2 = performance.now();
  console.log(`${String(size).padStart(5)} entries | entries=${store.entries.length} | recall ${(t1 - t0) / iterations}ms/iter (${hits / iterations} hits) | full inject ${(t2 - t1).toFixed(2)}ms | injected ${r.injected.length} of ${r.considered} | ${r.tokens} tokens`);
}
