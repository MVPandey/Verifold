"""A fake harness turn: join the lab over MCP with the agent's token, open a thread, and post in it."""

import asyncio
import os
import sys

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client


async def main(agent: str) -> None:
    headers = {'Authorization': f'Bearer {os.environ["VERIFOLD_TOKEN"]}'}
    async with (
        httpx2.AsyncClient(headers=headers) as http,
        Client(streamable_http_client(os.environ['VERIFOLD_URL'], http_client=http)) as client,
    ):
        request = {'kind': 'message', 'text': f'Hello from {agent}.', 'new_thread': f'Hello {agent}'}
        result = await client.call_tool('post', {'post': request})
        print('error' if result.is_error else 'posted', flush=True)


asyncio.run(main(sys.argv[1]))
