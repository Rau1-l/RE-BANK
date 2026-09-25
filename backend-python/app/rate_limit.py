import time
from collections import defaultdict, deque
from fastapi import HTTPException, Request

windows = defaultdict(deque)


def check_click_limit(request: Request, user_id):
    key = f'{request.client.host if request.client else "unknown"}|{user_id}'
    now = time.monotonic()
    queue = windows[key]
    while queue and now - queue[0] >= 1:
        queue.popleft()
    if len(queue) >= 5:
        raise HTTPException(status_code=429, detail='Too many clicks. Limit is 5 per second.')
    queue.append(now)
