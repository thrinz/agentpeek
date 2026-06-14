"""CLI helpers:  python -m app hash-password [PASSWORD]

Prints an AGENTPEEK_PASSWORD_HASH value to put in the systemd env file
(~/.config/agentpeek/agentpeek.env) to turn on login.
"""

import getpass
import sys

from . import auth


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "hash-password":
        password = sys.argv[2] if len(sys.argv) > 2 else getpass.getpass("Password: ")
        print(auth.hash_password(password))
        return
    sys.exit("usage: python -m app hash-password [PASSWORD]")


if __name__ == "__main__":
    main()
