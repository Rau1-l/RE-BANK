import hashlib
import math
import secrets
from datetime import datetime, timezone, timedelta


def normalize_username(value):
    return str(value or '').strip()


def validate_username(value):
    return 3 <= len(value) <= 50 and all(c.isalnum() or c in '_.-' for c in value)


def validate_password(value):
    return isinstance(value, str) and 8 <= len(value) <= 72


def normalize_card_number(value):
    return ''.join(str(value or '').split())


def luhn_valid(number):
    total = 0
    double_digit = False
    for char in reversed(number):
        digit = int(char)
        if double_digit:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
        double_digit = not double_digit
    return total % 10 == 0


def generate_card_number():
    base15 = '400012' + str(secrets.randbelow(1_000_000_000)).zfill(9)
    for check in range(10):
        candidate = base15 + str(check)
        if luhn_valid(candidate):
            return candidate
    raise RuntimeError('Unable to generate a valid card number')


def generate_cvv():
    return f'{secrets.randbelow(900) + 100:03d}'


def generate_exp_date():
    now = datetime.now(timezone.utc)
    target = now.replace(year=now.year + 5)
    return f'{target.month:02d}/{str(target.year)[-2:]}'


def format_card_holder(username):
    return username[:30].upper()


def valid_usd_amount(value):
    text = str(value)
    try:
        number = float(text)
    except ValueError:
        return False
    import re
    return bool(re.fullmatch(r'(?:0|[1-9]\d*)(?:\.\d{1,2})?', text)) and number > 0


def valid_crypto_amount(value):
    text = str(value)
    try:
        number = float(text)
    except ValueError:
        return False
    import re
    return bool(re.fullmatch(r'(?:0|[1-9]\d*)(?:\.\d{1,8})?', text)) and number > 0


def crypto_usd_rate():
    slot = int(datetime.now(timezone.utc).timestamp() // 10)
    digest = hashlib.sha256(str(slot).encode()).hexdigest()
    value = int(digest[:8], 16) % 20001
    return 40000 + value


def utc_start(days_ago=6):
    now = datetime.now(timezone.utc)
    day = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    return day - timedelta(days=days_ago)
