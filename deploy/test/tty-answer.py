#!/usr/bin/env python3
"""Onayını terminalden (/dev/tty) soran bir komutu sahte terminalde çalıştırır; soru GÖRÜNDÜĞÜNDE yanıtı yazar.

Yalnızca sunucu kurulumu testi içindir (takip restore'un "yedeğin tarihini yazın" onayı). Yanıt önceden yazılamaz:
komutun daha önce çalıştırdığı araçlar (docker compose exec) terminal girdisini okuyup tüketir.

Kullanım: tty-answer.py 'SORUDAN BİR PARÇA' 'YANIT' komut [argümanlar…]   → komutun çıkış kodu
"""
import os
import pty
import sys

prompt, answer, argv = sys.argv[1].encode(), sys.argv[2], sys.argv[3:]
seen = b''
answered = False


def read(fd):
    global seen, answered
    data = os.read(fd, 4096)
    if not answered:
        seen = (seen + data)[-8192:]
        if prompt in seen:
            os.write(fd, (answer + '\n').encode())
            answered = True
    return data


sys.exit(os.waitstatus_to_exitcode(pty.spawn(argv, read)))
