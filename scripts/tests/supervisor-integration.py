#!/usr/bin/env python3
"""Run against a private Supervisor; never connect to the host's daemon."""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import xmlrpc.client

from supervisor.xmlrpc import SupervisorTransport


root = Path(__file__).resolve().parents[2]
binary = Path(os.environ.get("RSM_E2E_BINARY", root / "build/rsm"))
manager = shutil.which("supervisord")
controller = shutil.which("supervisorctl")
if not binary.is_file() or not manager or not controller:
    sys.exit("Need a built RSM and an isolated test environment containing Supervisor")
passed = 0


def check(condition, label):
    global passed
    if not condition:
        raise AssertionError(label)
    passed += 1
    print("PASS " + label, flush=True)


def wait_until(operation):
    limit = time.monotonic() + 20
    while time.monotonic() < limit:
        try:
            value = operation()
            if value:
                return value
        except (OSError, xmlrpc.client.Error):
            pass
        time.sleep(0.1)
    raise AssertionError("Timed out waiting for isolated service")


with tempfile.TemporaryDirectory(prefix="rsm-supervisor-", dir=root / ".work") as temp:
    work = Path(temp)
    includes = work / "conf.d"
    includes.mkdir()
    config = work / "supervisord.conf"
    config.write_text(f"""[unix_http_server]
file={work}/supervisor.sock
chmod=0700
[supervisord]
logfile={work}/supervisor.log
pidfile={work}/supervisord.pid
childlogdir={work}
[rpcinterface:supervisor]
supervisor.rpcinterface_factory=supervisor.rpcinterface:make_main_rpcinterface
[supervisorctl]
serverurl=unix://{work}/supervisor.sock
[include]
files=conf.d/*.conf
""")
    app_config = includes / "app.conf"
    app_config.write_text(f"""[program:app]
command={shlex.quote(sys.executable)} -c 'import time; time.sleep(10000)'
startsecs=0
stdout_logfile={work}/app.log
redirect_stderr=true
""")
    main_before = config.read_bytes()
    output = open(work / "manager.log", "w")
    daemon = subprocess.Popen([manager, "-n", "-c", str(config)], stdout=output, stderr=subprocess.STDOUT)
    def rpc():
        return xmlrpc.client.ServerProxy("http://127.0.0.1", transport=SupervisorTransport("", "", "unix://" + str(work / "supervisor.sock")))
    home = work / "instance with space 50%"
    release = home / "releases/0.1.1-test"
    release.mkdir(parents=True)
    shutil.copy2(binary, release / "rsm")
    version = subprocess.check_output([str(binary), "--version"], text=True).strip().split()[-1]
    (release / "release.json").write_text(json.dumps({"version": version, "schemaVersion": 1, "releaseId": "0.1.1-test"}, indent=2))
    (home / "current").symlink_to(release)
    shutil.copy2(root / "rsm.sh", home / "rsm.sh")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    addr = f"127.0.0.1:{port}"
    base = "http://" + addr
    helper = work / "manage.sh"
    helper.write_text("""#!/usr/bin/env bash
set -u
set -o pipefail
RSM_ROOT="$1"; RSM_HOME="$2"; RSM_ADDR="$3"; RSM_ADDR_REQUESTED="$3"
. "$RSM_ROOT/scripts/lib/common.sh"
. "$RSM_ROOT/scripts/lib/instance.sh"
. "$RSM_ROOT/scripts/lib/service.sh"
host_os() { printf linux; }
if [ "$(uname -s)" != Linux ]; then
  process_cmdline() { ps -p "$1" -o command=; }
fi
file_size() { python3 -c 'import os,sys; print(os.path.getsize(sys.argv[1]))' "$1"; }
state_load
case "$4" in
  plain-start|start) start_instance ;;
  enable) service_install_and_start ;;
  stop) stop_instance ;;
  restart) restart_instance ;;
  disable) service_remove ;;
  status) autostart_status_print ;;
  guard) supervisor_bind; supervisor_ctl update app ;;
esac
""")
    env = {**os.environ, "PATH": str(Path(manager).parent) + os.pathsep + os.environ["PATH"], "RSM_SUPERVISOR_CONFIG": str(config)}
    group = "rsm-" + hashlib.sha256(str(home).encode()).hexdigest()[:8]
    def manage(action, expected=True, extra_env=None):
        result = subprocess.run(["bash", str(helper), str(root), str(home), addr, action], env={**env, **(extra_env or {})}, capture_output=True, text=True, timeout=70)
        with open(work / "actions.log", "a") as log:
            log.write(action + "\n" + result.stdout + result.stderr)
        if (result.returncode == 0) != expected:
            raise AssertionError(action + "\n" + result.stdout + result.stderr)
        return result

    def health():
        with urllib.request.urlopen(base + "/healthz", timeout=2) as response:
            return json.load(response)

    def rsm_pid():
        return int((home / "run/rsm.pid").read_text().strip())

    try:
        app = wait_until(lambda: rpc().supervisor.getProcessInfo("app"))
        app_identity = app["pid"], app["start"]

        def app_unchanged():
            current = rpc().supervisor.getProcessInfo("app")
            return (current["pid"], current["start"]) == app_identity and current["statename"] == "RUNNING" and config.read_bytes() == main_before

        manage("plain-start")
        original_pid = rsm_pid()
        check(health()["version"] == version, "plain background instance is healthy before handoff")
        cookie_jar = http.cookiejar.CookieJar()
        browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
        setup = urllib.request.Request(base + "/api/setup", data=json.dumps({"password": "测"}).encode(), headers={"Content-Type": "application/json"})
        with browser.open(setup) as response:
            state = json.load(response)
        expected_revision = state["revision"]
        key_before = (home / "secrets/password.key").read_bytes()
        bad_config = includes / "invalid.conf"
        bad_config.write_text("[program:invalid]\ncommand=/bin/true\nstartsecs=not-a-number\n")
        manage("enable", expected=False)
        check(rsm_pid() == original_pid and health()["revision"] == expected_revision and app_unchanged(), "invalid shared configuration preserves the existing RSM and unrelated app")
        check(not (includes / (group + ".conf")).exists(), "failed validation removes only its staged RSM configuration")
        bad_config.unlink()
        # A pending unrelated configuration change must remain unapplied.
        app_config.write_text(app_config.read_text() + "environment=RSM_UNRELATED_PENDING=\"1\"\n")
        manage("enable")
        check(rsm_pid() != original_pid and rpc().supervisor.getProcessInfo(group)["pid"] == rsm_pid(), "Supervisor takes over only the RSM process, including paths with spaces and percent")
        check(app_unchanged(), "enable leaves unrelated app PID, start time and main configuration unchanged")
        check("Supervisor" in manage("status").stdout, "status reports the independent Supervisor registration")
        managed_pid = rsm_pid()
        manage("enable")
        check(rsm_pid() == managed_pid and app_unchanged(), "repeated enable is idempotent without restarting either service")
        manage("guard", expected=False)
        check(app_unchanged(), "command guard rejects updating another process group")
        manage("stop")
        check(rpc().supervisor.getProcessInfo(group)["statename"] == "STOPPED" and app_unchanged(), "stop disables manager restarts for RSM without stopping app")
        manage("start")
        check(health()["revision"] == expected_revision and app_unchanged(), "start uses Supervisor and retains the database")
        managed_pid = rsm_pid()
        os.kill(managed_pid, signal.SIGKILL)
        wait_until(lambda: rsm_pid() != managed_pid and health()["version"] == version)
        check(app_unchanged(), "an unexpected RSM crash restarts only RSM")
        manage("restart")
        with browser.open(base + "/api/state") as response:
            state = json.load(response)
        check(state["me"]["username"] == "张金科" and state["revision"] == expected_revision and (home / "secrets/password.key").read_bytes() == key_before, "restart preserves login session, committed data and password key")
        check(app_unchanged(), "restart leaves unrelated app running with its original PID")
        manage("disable")
        check(not (home / "run/supervisor-config").exists() and not (includes / (group + ".conf")).exists() and app_unchanged(), "disable removes only RSM registration and configuration")
        manage("plain-start")
        original_pid = rsm_pid()
        collision = includes / (group + ".conf")
        collision.write_text("# someone else's configuration\n[program:" + group + "]\ncommand=/bin/true\n")
        manage("enable", expected=False)
        check(rsm_pid() == original_pid and collision.read_text().startswith("# someone else") and app_unchanged(), "foreign same-name configuration is never overwritten or started")
        collision.unlink()
        shim_dir = work / "shim"
        shim_dir.mkdir()
        shim = shim_dir / "supervisorctl"
        shim.write_text("#!/usr/bin/env bash\ncase \" $* \" in *' update '*) exit 1 ;; esac\nexec " + shlex.quote(controller) + ' "$@"\n')
        shim.chmod(0o755)
        manage("enable", expected=False, extra_env={"PATH": str(shim_dir) + os.pathsep + env["PATH"]})
        check(health()["revision"] == expected_revision and not (home / "run/supervisor-config").exists() and app_unchanged(), "failed handoff restores background RSM without touching app")
        manage("stop")
        check(app_unchanged(), "all RSM lifecycle operations preserve the unrelated service")
        print(f"{passed} real Supervisor isolation checks passed", flush=True)
    except Exception:
        for log in (work / "actions.log", work / "manager.log", work / "supervisor.log", home / "logs/rsm.log"):
            if log.exists():
                print(str(log) + "\n" + log.read_text(errors="replace")[-12000:], file=sys.stderr)
        raise
    finally:
        try:
            manage("stop")
        except Exception:
            if (home / "run/rsm.pid").is_file():
                pid = int((home / "run/rsm.pid").read_text().strip())
                command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
                if str(home) in command and " serve " in command:
                    os.kill(pid, signal.SIGTERM)
        try:
            rpc().supervisor.shutdown()
        except Exception:
            daemon.terminate()
        try:
            daemon.wait(timeout=25)
        except subprocess.TimeoutExpired:
            daemon.kill()
            daemon.wait()
        output.close()
