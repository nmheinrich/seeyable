# Act 1 — four-sentence acceptance script

Agreed reference defined on 2026-10-31 at the Product Owner's request.
Status: PASSED — Product Owner confirmed the complete ordered script typed
then spoken on the corrected implementation on 2026-10-31. Sentences 1,
3, and 4 passed initially; sentence 2 initially failed and passed after
the dropdown metadata correction, followed by the full rerun. This is
human-reported headed genuine-model evidence, not an automated browser run.
Voice recognition remains imperfect and requires clear speech; demo
acceptance does not establish general transcription accuracy.

Use only the pre-existing local demo survey and fictional data. Reload the
survey to reset its controls; open Seeyable, verify planner pairing and key
configuration, and ensure the gate is resumed. Run sentences in order, first
typed and then spoken after another survey reload. Wait for each result.
For voice, record the actual transcript separately from the intended words.

1. "Put Ada Lovelace in Full name and Pioneer in Nickname."
   Expect two verified fills: Full name = Ada Lovelace; Nickname = Pioneer.
2. "Choose Designer for Your role, turn off Email updates, turn on SMS updates, and choose Monthly digest."
   Expect Your role = Designer (native value designer), Email updates unchecked,
   SMS updates checked, Monthly digest selected and Weekly digest unselected.
   This varies action types: select, uncheck, check, and radio selection.
3. "Replace Short bio with: I design clear forms, test small details, and help people get things done."
   Expect a verified Short bio replacement with the text after the colon.
   Typed punctuation must be preserved. Spoken execution is compared with the
   recognized value, and any recognition difference is recorded, not silently
   counted as exact dictation success. A value-only difference must not alter
   the intended target or create extra actions.
4. "Please submit this survey."
   Expect human confirmation before any submission; the form remains unsubmitted.
   Click Cancel (a verification action outside the four sentences), confirm no
   submission, and confirm the cancelled request never replays.

Do not approve submission during this acceptance run. No real personal data,
external forms, payments, deletion, or publishing. No plan-preview, read-back,
voice approval, or undo behavior is promised by this script.

Record each outcome separately. If clarification is needed, record it and the
chosen target rather than describing the run as uninterrupted. A stopped,
failed, or unverified step must not be reported as completed. Report typed and
spoken results independently, including transcript differences and any retry.
This script covers multi-target filling, different control types, dictation,
and the safety gate. Ambiguity/cached correction and Pause/Resume/no-replay
remain separate acceptance checks already recorded in docs/status.md.
