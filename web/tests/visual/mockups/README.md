# Mockups the visual gate compares against

Byte copies of owner-approved drafts from the project's `.scratch/v2-drafts/` and its `ko/` folder (copied 2026-10-28). The STYLE decision
(2026-10-28 16:08, amended 16:12) makes these ko/ mockups the canonical look; do not edit them to make a test pass.

| file | approved by | sha256 |
|---|---|---|
| `hiderows-r6.html` | HIDEROWS (2026-10-28 09:20): decision rows, mockup r6 | `5ddaade0ed2590930cd97016f01219d21070f0a033877ce6ca2c16d0b0f755b6` |
| `v2-8a-groups.html` | TREEROWS (2026-10-27 22:16): mockup A + folds + G2 | `348921efa34bceedf8d8bcfd664ca09cc0cf302aab37bf9f631141cbc9810e72` |
| `v2-8a-a-folds.html` | STYLE (2026-10-28 16:08) and TREEROWS (2026-10-27 22:16): mockup A + folds | `e297908f6f50c02cb5de364c91e0c1dc091ed3787e16c81cac921fd91df83674` |
| `05-context-undo.html` | V2SCREENS (owner, 2026-10-28 10:45): 05 Option A, anchored menu (`#o5a`); an R8-token draft, compared after `r8-map.ts` | `63e9192d17716d60646ece38d7844fa40ed229b5634e7be1052e61a7f412978b` |
| `06-search.html` | V2SCREENS (owner, 2026-10-28 10:45): 06 Option A with scope chips (`#o6a`); an R8-token draft, compared after `r8-map.ts` | `c889bd0596e6c1225da5c575098b2a4cbacc93d30f9b2a336e7b968533f6b856` |
| `02-agent-switch.html` | V2ROUND2 (owner, 2026-10-28 11:05): 02 accepted, Option B composer picker (`#opt-b .pop`); an R8-token draft, compared after `r8-map.ts` | `dc8caeac4eacf69d52ad7b713ef65465f8ad6c529eacd8db4c96cb8e6dffe286` |
| `round2.html` | V2ROUND2 (owner, 2026-10-28 11:05): `#s02`, the ko picker with its upper `.cap` group label | `cffb64ffbb80dc64f8f84deba06885b2662b3cd2d8434f0228719b53cd63a5ce` |
| `layout-d5b.html` | LAYOUT D5b (2026-10-28 12:47): widgets nest under a project as sub-views, tree-icon picker | `cffb5956f1df927ad4d85cfac290a8d95c55f97a255dc02396334313eb36223a` |
| `frame-ko-e.html` | FRAME (approved by owner, 2026-10-28 16:36) + PANE/RIGHTBAR 16:47: window chrome (tab strip, status bar, chat, composer, board, settings); same chrome as frame-ko-d.html | `0ea13898fca466de7af22e61f891aa3e850974fb6d850eee059a1d2aa4a09d1f` |
| `claude-feel-2.html` | CLAUDEFEEL (owner, 2026-10-28 22:23, needs 121): chat body and composer structure; structure, not colour, is the promise | `073e60dd4512d3fc3f470fee609d2114b2c8628bb2996c3c91c87724ff312b18` |
| `v2-8a-compare-r3.html` | WTDIALOGS (needs 96) Draft 3, STYLE (2026-10-28 16:08): new worktree (Draft 1 One-click+), discard dialog, undo toast, Tidy panel; ticket 529 (2026-11-13) added the later decisions, ticket 468's field border and fill and ticket 294's Cancel at the hint line end; ticket 1041 lane 8 (owner 11-22) clears the field border and gives the field the tint fill (--tint-1 light and dark) and radius 6 | `e0ebb40258d8ba561bf38814da3fc17480003604388223de04fe9b81aa463370` |
| `03-acp-setup.html` | V2SCREENS (owner, 2026-10-28 10:45, "03 A (+agents.toml link)"): 03 Option A (`#opt-a`), Settings > Agents and the "Set up Gemini CLI" sheet; Options B and C are not approved. An R8-token draft, compared after `r8-map.ts` | `ad2db103beaf3480932a6dcf180a240b93407385123c74106f4830e950f1b821` |
| `tree-done.html` | Finished sessions in the tree: hollow bars beside the colour strip, a fading "just finished" row (tree-done-1022.spec.ts) | `8b2b155e48de457d788329cf915525d9bdedc6813c6f0af751c23142423328e6` |
| `polish-abc.html` | The A+B+C polish window (`.win.v-c`): tree row height, state word, working line, your-turn edge (tree-polish-1041.spec.ts) | `0962d99d7a52a81ef538def2cc11a7ebbc8df6e9e6d77c6f8117ff59e61b21b9` |

Add a file here (with its decision and hash) before a test crops it; a missing file fails the gate.
