"""Scorecard p31 SK2 (ticket 1130 C-C2 item 1.1): every shipped skill's description says when to load it and when not,
stays under 80 words, and has a trigger set of 8 should-load and 8 should-not prompts for `claude plugin eval`
(plugin/evals/trigger-<skill>/), graded on whether the Skill tool loaded that skill. Reads files only; no model runs."""
import glob
import os
import re
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SKILLS = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(os.path.join(ROOT, "plugin/skills/*/SKILL.md")))


def read(path):
    with open(path) as f:
        return f.read()


def description(skill):
    text = read(os.path.join(ROOT, "plugin/skills", skill, "SKILL.md"))
    return re.search(r"^description: *\"?(.*?)\"?$", text, re.M).group(1)


class SkillTriggers(unittest.TestCase):
    def test_three_skills(self):
        self.assertEqual(SKILLS, ["artifacts", "nunchiro", "orchestration"])

    def test_descriptions_say_when_and_when_not(self):
        for skill in SKILLS:
            d = description(skill)
            self.assertLess(len(d.split()), 80, skill)
            self.assertRegex(d, r"\b(Use when|Required before)\b", skill)
            self.assertRegex(d, r"\b(Not for|prefer your own)\b", skill)

    def test_trigger_set_per_skill(self):
        for skill in SKILLS:
            cases = sorted(glob.glob(os.path.join(ROOT, "plugin/evals", f"trigger-{skill}", "*", "case.yaml")))
            load = [c for c in cases if os.path.basename(os.path.dirname(c)).startswith("load-")]
            skip = [c for c in cases if os.path.basename(os.path.dirname(c)).startswith("skip-")]
            self.assertEqual((len(load), len(skip), len(cases)), (8, 8, 16), skill)
            match = re.compile(r"input_match: '\"skill\"\\s\*:\\s\*\"\(\?:\[\\w-\]\+:\)\?" + skill + r"\"'")
            for path in cases:
                text = read(path)
                name = os.path.basename(os.path.dirname(path))
                self.assertIn('schema_version: "1.1"', text, path)
                self.assertIn(f"name: trigger-{skill}-{name}", text, path)
                self.assertIn(f"tags: [trigger, trigger-{skill}]", text, path)
                self.assertRegex(text, r"(?m)^  prompt: \".+\"$", path)
                self.assertIn("type: tool_used", text, path)
                self.assertIn("tool: Skill", text, path)
                self.assertRegex(text, match, path)
                negative = "min: 0" in text and "max: 0" in text and "arm: both" in text
                self.assertEqual(negative, name.startswith("skip-"), path)

    def test_prompts_are_unique_within_a_set(self):
        for skill in SKILLS:
            prompts = [re.search(r"(?m)^  prompt: (.+)$", read(p)).group(1)
                       for p in glob.glob(os.path.join(ROOT, "plugin/evals", f"trigger-{skill}", "*", "case.yaml"))]
            self.assertEqual(len(prompts), len(set(prompts)), skill)

    def test_evals_stay_out_of_the_installed_plugin(self):
        # The core embeds named plugin files (sessions/skill.rs); evals must never be among them.
        src = read(os.path.join(ROOT, "crates/nunchiro-core/src/sessions/skill.rs"))
        self.assertNotIn("evals/", src)


if __name__ == "__main__":
    unittest.main()
