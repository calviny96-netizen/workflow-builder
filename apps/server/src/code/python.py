# Load approved standard-library modules before denying filesystem/network/process syscalls.
import sys, json, re, math, datetime, statistics, collections, itertools, functools
import decimal, random, hashlib, base64, csv, io, unicodedata, resource, ctypes, errno, _strptime, calendar
request = json.loads(sys.stdin.read())
resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (request['timeout'] + 1, request['timeout'] + 1))
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
lib = ctypes.CDLL('libseccomp.so.2', use_errno=True)
lib.seccomp_init.argtypes = [ctypes.c_uint32]
lib.seccomp_init.restype = ctypes.c_void_p
lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
lib.seccomp_load.argtypes = [ctypes.c_void_p]
lib.seccomp_release.argtypes = [ctypes.c_void_p]
ctx = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
if not ctx:
    raise RuntimeError('Tidak dapat membuat sandbox Python.')
blocked = '''open openat openat2 creat open_by_handle_at name_to_handle_at socket socketpair connect bind listen accept accept4 sendto sendmsg sendmmsg recvmsg recvmmsg
execve execveat fork vfork clone clone3 ptrace process_vm_readv process_vm_writev pidfd_open pidfd_getfd pidfd_send_signal kill tkill tgkill
mount umount2 pivot_root chroot setns unshare bpf perf_event_open io_uring_setup io_uring_enter io_uring_register keyctl add_key request_key
unlink unlinkat rename renameat renameat2 mkdir mkdirat rmdir link linkat symlink symlinkat chmod fchmod fchmodat chown fchown fchownat lchown truncate ftruncate
mknod mknodat fallocate utime utimes futimesat utimensat setxattr fsetxattr lsetxattr removexattr fremovexattr lremovexattr
readlink readlinkat stat lstat statx newfstatat access faccessat faccessat2 getdents getdents64 open_tree fsopen fsconfig fsmount move_mount mount_setattr
reboot kexec_load kexec_file_load init_module finit_module delete_module swapon swapoff'''.split()
for name in blocked:
    syscall = lib.seccomp_syscall_resolve_name(name.encode())
    if syscall >= 0 and lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, syscall, 0) != 0:
        raise RuntimeError('Tidak dapat menerapkan sandbox Python.')
if lib.seccomp_load(ctx) != 0:
    raise RuntimeError('Sandbox Python tidak tersedia; kode tidak dijalankan.')
lib.seccomp_release(ctx)
logs = []
class LogWriter:
    def write(self, text):
        if len(logs) < 50 and text.strip(): logs.append(text[:2000])
        return len(text)
    def flush(self): pass
class Input:
    def __init__(self, values): self.values = values; self.item = values[0] if values else {'json': {}}
    def all(self): return self.values
    def first(self): return self.item
    def last(self): return self.values[-1] if self.values else self.item
stdout = sys.stdout
sys.stdout = LogWriter()
try:
    code = 'def __user_code():\n' + '\n'.join('    ' + line for line in request['code'].splitlines())
    compiled = compile(code, 'user-code.py', 'exec')
    items = request['items']
    def execute(batch, index=0):
        scope = {'_input':Input(batch), '_items':batch, '_item':batch[0] if batch else {'json':{}}, '_json':batch[0]['json'] if batch else {}, '_itemIndex':index, 'params':request.get('params',{})}
        exec(compiled, scope)
        return scope['__user_code']()
    if request['mode'] == 'each':
        output = []
        for index, item in enumerate(items):
            value = execute([item],index)
            if value is not None: output.extend(value if isinstance(value,list) else [value])
    else: output = execute(items)
    result = json.dumps({'output':output,'logs':logs},ensure_ascii=False,allow_nan=False)
except BaseException as error:
    result = json.dumps({'error':type(error).__name__ + ': ' + str(error)})
stdout.write(result)
