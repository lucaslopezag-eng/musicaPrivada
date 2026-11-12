#!/usr/bin/env python3
"""
Operaciones remotas sobre el servidor de MusicaPrivada (sustituye a deploy.py,
deploy_now.py, get_logs.py y check_db.py).

SEC-00:
  * Sin contraseñas en el código: host, usuario y clave SSH se leen de .env.
  * Autenticación SOLO por clave SSH.
  * Verificación estricta de host (known_hosts); se rechazan hosts desconocidos
    en lugar de aceptarlos en silencio (AutoAddPolicy permitía ataques MITM).

Uso:
  python tools/remote_ops.py deploy     # ejecuta deploy/update.sh en el servidor
  python tools/remote_ops.py logs       # últimas 150 líneas de PM2
  python tools/remote_ops.py stats      # resumen de play_history por usuario/año

Requisitos: pip install paramiko python-dotenv
Primera vez: conéctate una vez con `ssh usuario@host` para registrar la huella.
"""
import os
import shlex
import sys

import paramiko

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
except ImportError:
    pass


def env(name, default=None, required=True):
    value = os.environ.get(name, default)
    if required and not value:
        print(f"Falta la variable {name} en .env")
        sys.exit(1)
    return value


def connect():
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(
        env("DEPLOY_HOST"),
        port=int(env("DEPLOY_PORT", "22")),
        username=env("DEPLOY_USER"),
        key_filename=os.path.expanduser(env("DEPLOY_KEY_FILE")),
        allow_agent=True,
        look_for_keys=False,
        timeout=15,
    )
    return client


def run(client, command):
    _, stdout, stderr = client.exec_command(command, get_pty=False)
    for line in iter(stdout.readline, ""):
        print(line, end="")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if err.strip():
        print(err, file=sys.stderr)
    return code


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("deploy", "logs", "stats"):
        print(__doc__)
        sys.exit(1)
    action = sys.argv[1]
    remote_dir = shlex.quote(env("DEPLOY_REMOTE_DIR"))
    app = shlex.quote(env("DEPLOY_PM2_APP", "musica-privada"))
    client = connect()
    try:
        if action == "deploy":
            code = run(client, f"cd {remote_dir} && bash deploy/update.sh")
        elif action == "logs":
            code = run(client, f"pm2 logs {app} --lines 150 --nostream")
        else:
            sql = ("SELECT username, strftime('%Y', played_at) AS year, COUNT(*), MIN(played_at), MAX(played_at) "
                   "FROM play_history GROUP BY username, year;")
            code = run(client, f"cd {remote_dir} && sqlite3 -readonly database.sqlite {shlex.quote(sql)}")
    finally:
        client.close()
    sys.exit(code)


if __name__ == "__main__":
    main()
