import sys
import struct
import json
import subprocess

msg = {"type": "health"}
data = json.dumps(msg).encode('utf-8')
length_prefix = struct.pack('<I', len(data))

p = subprocess.Popen(
    ['/Users/amit/Development/TopicBlock/native/topicblock-native'],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE
)

out, err = p.communicate(input=length_prefix + data)

print("Return code:", p.returncode)
print("STDOUT bytes:", len(out))
print("STDOUT:", repr(out))
print("STDERR bytes:", len(err))
print("STDERR:", repr(err))
