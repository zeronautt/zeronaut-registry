import re
import os

path = r"C:\Users\sonid\.gemini\antigravity\brain\5c1606ae-f725-4eb9-8f2d-6210fd92b4cb\.system_generated\steps\42\content.md"

if os.path.exists(path):
    print("File exists!")
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    for idx, line in enumerate(lines):
        if any(w in line.lower() for w in ["wallet", "withdraw", "payout"]):
            print(f"Line {idx+1}: {line.strip()}")
else:
    print("File does NOT exist in the environment's direct view of this path.")
