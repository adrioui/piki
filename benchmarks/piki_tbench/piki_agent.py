"""Harbor Terminal-Bench 2.1 adapter for piki.

Runs piki (repo-local build at packages/coding-agent/dist/cli.js) against
Terminal-Bench 2.1 tasks via Harbor. Model routing is handled entirely by
piki's own settings — no model is hardcoded here.
"""

import json
import shlex
from pathlib import Path as PathLib
from tempfile import NamedTemporaryFile
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

CONTAINER_PIKI_PATH = "/opt/piki/packages/coding-agent/dist/cli.js"
CONTAINER_CONFIG_DIR = "/tmp/piki-tbench"
CONTAINER_CREDS_DIR = "/tmp/piki-creds"


async def _upload_json(
    environment: BaseEnvironment, target: str, value: object
) -> None:
    with NamedTemporaryFile(mode="w", suffix=".json", delete=False) as handle:
        path = PathLib(handle.name)
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
    try:
        await environment.upload_file(source_path=path, target_path=target)
    finally:
        path.unlink(missing_ok=True)


async def _ensure_node(environment: BaseEnvironment) -> None:
    """Install Node.js in the container if not already present."""
    result = await environment.exec(
        command="which node 2>/dev/null && node --version 2>/dev/null || echo 'NODE_NOT_FOUND'"
    )
    if "NODE_NOT_FOUND" in result.stdout:
        # Install Node.js 22 directly from official binaries
        # (distro nodejs packages are often too old for piki)
        await environment.exec(
            command=(
                "apt-get update -qq 2>/dev/null || true; "
                "apt-get install -y -qq curl xz-utils ca-certificates 2>/dev/null || true; "
                "curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz "
                "-o /tmp/node.tar.xz && "
                "tar -xf /tmp/node.tar.xz -C /usr/local --strip-components=1 && "
                "rm /tmp/node.tar.xz"
            ),
            user="root",
        )
        # Verify node works
        result = await environment.exec(command="node --version")
        if result.return_code != 0:
            raise RuntimeError(
                f"Failed to install Node.js: {result.stdout} {result.stderr}"
            )


class PikiTbenchAgent(BaseInstalledAgent):
    """Run piki against Terminal-Bench 2.1 tasks.

    Uses the repo-local piki build mounted at /opt/piki inside the container.
    Does not hardcode a model; piki's own settings/config handle model routing.
    """

    SUPPORTS_ATIF = True

    def __init__(self, *args, executable_path: str = CONTAINER_PIKI_PATH, **kwargs):
        super().__init__(*args, **kwargs)
        self.executable_path = executable_path

    @staticmethod
    @override
    def name() -> str:
        return "piki-tbench"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await _ensure_node(environment)

        # Verify piki CLI works
        result = await environment.exec(
            command=f"node {shlex.quote(self.executable_path)} --version"
        )
        if result.return_code != 0 or not result.stdout:
            raise RuntimeError(
                f"piki CLI not working at {self.executable_path}"
                f" return_code={result.return_code} stdout={result.stdout!r} stderr={result.stderr!r}"
            )

        # Set up isolated config directory so ~/.piki is never touched
        await environment.exec(
            command=f"mkdir -p {CONTAINER_CONFIG_DIR}", user="root"
        )
        # Copy auth.json and models.json from the mounted credentials directory
        # into the isolated config directory so piki can resolve provider keys
        # without touching ~/.piki.
        await environment.exec(
            command=(
                f"cp {CONTAINER_CREDS_DIR}/auth.json {CONTAINER_CONFIG_DIR}/auth.json && "
                f"cp {CONTAINER_CREDS_DIR}/models.json {CONTAINER_CONFIG_DIR}/models.json && "
                f"chmod 600 {CONTAINER_CONFIG_DIR}/auth.json"
            ),
            user="root",
        )
        # Copy commandcode auth so piki can resolve commandcode/mimo-v2.5-pro.
        # Piki checks ~/.commandcode/auth.json via os.homedir(); in the container
        # the user is root, so copy to /root/.commandcode/auth.json.
        await environment.exec(
            command=(
                "mkdir -p /root/.commandcode && "
                f"cp {CONTAINER_CREDS_DIR}/commandcode-auth.json /root/.commandcode/auth.json && "
                "chmod 600 /root/.commandcode/auth.json"
            ),
            user="root",
        )
        # Write benchmark routing config with required role models.
        # CommandCode MiMo V2.5 Pro for decision roles; advisor on GPT-5.6 Sol;
        # scout/artisan on OpenCode DeepSeek V4 Flash Free.
        await _upload_json(
            environment,
            f"{CONTAINER_CONFIG_DIR}/settings.json",
            {
                "roleModels": {
                    "leader": "huancheng/glm-5.2",
                    "critic": "huancheng/glm-5.2",
                    "scientist": "huancheng/glm-5.2",
                    "engineer": "huancheng/glm-5.2",
                    "advisor": "openai-codex/gpt-5.6-sol",
                    "scout": "opencode/deepseek-v4-flash-free",
                    "artisan": "opencode/deepseek-v4-flash-free",
                },
                "defaultThinkingLevel": "medium",
                "defaultProvider": "commandcode",
                "defaultModel": "mimo-v2.5-pro",
            },
        )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        command = (
            f"PIKI_CODING_AGENT_DIR={CONTAINER_CONFIG_DIR} "
            f"node {shlex.quote(self.executable_path)} "
            "--print --mode json "
            "--atif /logs/agent/trajectory.json "
            f"{shlex.quote(instruction)} "
            ">/logs/agent/stdout.log 2>/logs/agent/stderr.log"
        )
        await self.exec_as_agent(environment, command=command, cwd="/app", env=self.extra_env)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        context.metadata = {
            **(context.metadata or {}),
            "agent": self.name(),
            "executable": self.executable_path,
        }
