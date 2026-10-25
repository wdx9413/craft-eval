"""Run one of PocketFlow's own unittest files from outside its repo.

The evaluator copies only the workspace, so the subject repo is imported by
absolute path and the test module is loaded from its file.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

REPO = Path(r"D:\documents\project\mytest\eval-subjects\pocketflow")
sys.path.insert(0, str(REPO))

path = REPO / sys.argv[1]
spec = importlib.util.spec_from_file_location("subject_test", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

suite = unittest.defaultTestLoader.loadTestsFromModule(module)
result = unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
