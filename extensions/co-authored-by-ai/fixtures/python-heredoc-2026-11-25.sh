cd /repo && mkdir -p .pi/skills/eod && python3 - <<'PYEOF'
import re
from pathlib import Path
s=Path('.ultimate/skills/eod/SKILL.md').read_text()
def rep(o,n):
    global s
    assert s.count(o)==1,(o[:70],s.count(o)); s=s.replace(o,n)
s=re.sub(r'description: .*', "description: End-of-day review. Compare today's plan with what was done, flag displacement, carry and stale commitments, write the plan's End of Day Review and update today's dailyContext. Use when Rodrigo asks for EOD or the EOD flag check.", s, count=1)
rep("The Ultimate version of pi's EOD review and `.pi/prompts/eod-flag-check.md`.","pi's EOD review. It extends `.pi/prompts/eod-flag-check.md`. (Moved from the retired `.ultimate/skills/eod` on Nov 25 2026.)")
rep(" (pi and Ultimate share this folder; a manual EOD before 17:30 must not be duplicated.)","")
rep("ask Rodrigo (question card)","ask Rodrigo (`ask` tool)")
i=s.index("1. **World's Ultimate today.**"); j=s.index("2. **Gather what happened today**")
s=s[:i]+s[j:]
s=s.replace("2. **Gather what happened today**","1. **Gather what happened today**")
lines=[l for l in s.splitlines(True) if not l.startswith("   - World's Ultimate: the conversations")]
s=''.join(lines)
rep('(enable the `slack` backend first; see AGENTS.md "Running in Ultimate")','(enable the `slack` backend first; see AGENTS.md "Routines and Conventions"). `after:{yesterday}` returns today only, because `after:` is exclusive. Also re-read the threads named in today\'s plan as owed replies, to see whether the replies went out')
rep(" (World's Ultimate work goes here when it was not planned, with its conversation number)","")
s=s.replace("3. **Write the End of Day Review**","2. **Write the End of Day Review**")
i=s.index("4. **Refresh the World block"); j=s.index("6. **Commit**")
s=s[:i]+"3. **Update today's dailyContext.** With `memory_append` on `core/dailyContext.md`, add 1–3 concise lines under `### Context for Tomorrow`: the top carried item, any displacement flag, and the first action for the next workday. Keep the file under 150 lines and don't repeat lines that are already there.\n\n"+s[j:]
rep("6. **Commit** the plan file: `git add plans/YYYYMMDD.plan.md && git commit -qm \"{TA} EOD review: YYYY-MM-DD\"`, plus `signals/YYYYMMDD-ultimate-eod.json` when it was written. The pi memory files are outside the repo and are not committed.",
    "4. **Commit** the plan file: `git add plans/YYYYMMDD.plan.md && git commit -qm \"{TA} EOD review: YYYY-MM-DD\"`. The pi memory files are outside the repo and are not committed.")
s=s.replace("7. **Present and ask.**","5. **Present and ask.**")
s=s.replace("Ask in one question card:","Ask in one `ask` call:")
lines=[l for l in s.splitlines(True) if "superseded hand-written World lines" not in l]
s=''.join(lines)
Path('.pi/skills/eod/SKILL.md').write_text(s)
print(len(re.findall('(?i)ultimate',s)), re.findall(r'^\d\. \*\*[^*]+', s, re.M))
PYEOF