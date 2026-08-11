from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "src" / "rex_workflow.py"
SPEC = importlib.util.spec_from_file_location("rex_workflow", MODULE_PATH)
assert SPEC and SPEC.loader
workflow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workflow)


class PullRequestPolicyTests(unittest.TestCase):
    def test_feature_branch_may_target_staging_without_shareview_issue(self):
        workflow.validate_pr("staging", "rex-staging-workflow", "")

    def test_only_staging_may_target_main(self):
        workflow.validate_pr("main", "staging", "")
        with self.assertRaisesRegex(workflow.WorkflowError, "Only staging"):
            workflow.validate_pr("main", "feature", "")

    def test_other_bases_are_rejected(self):
        with self.assertRaisesRegex(workflow.WorkflowError, "must target"):
            workflow.validate_pr("release", "feature", "")

    def test_protected_branch_cannot_be_feature_head(self):
        with self.assertRaisesRegex(workflow.WorkflowError, "feature branch"):
            workflow.validate_pr(
                "staging", "main",
                "",
            )


class BranchPolicyTests(unittest.TestCase):
    def test_protected_branch_names_are_rejected(self):
        for branch in ("main", "staging"):
            with self.subTest(branch=branch):
                with self.assertRaisesRegex(workflow.WorkflowError, "cannot be"):
                    workflow.validate_branch_name(branch)

    def test_normal_feature_branch_is_allowed(self):
        workflow.validate_branch_name("rex-1340-staging-workflow")


if __name__ == "__main__":
    unittest.main()
