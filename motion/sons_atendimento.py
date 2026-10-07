"""Trilha e efeitos de anuncio-atendimento.html (tempos espelham o objeto T do HTML)."""
import sfx
from sfx import Mix

DUR = 27.0
T = dict(
    hookOut=2.7, team=2.95, teamOut=7.9,
    chat=8.15, q1=8.9, q2=9.6, q3=10.3, fClick=11.3, fAll=12.6,
    c3=13.4, m3=13.7, tClick=14.4, ddPick=15.2, tGo=15.9, m4=16.15,
    c4=18.4, slash=18.9, qPick=19.6, fill=19.9, send=20.5, nIn=21.3, nClick=22.3, chatOut=23.55,
    end=23.8,
)
music = sfx.groove(DUR, T['team'], T['end'])
fx = Mix(DUR)
sfx.standard_open_close(fx, T['hookOut'], T['team'], T['end'])

for i in range(4):
    t0 = T['team'] + 0.6 + i * 0.35
    fx.add(sfx.whoosh(0.4, 0.12, up=True, seed=50 + i), t0, pan=-0.4 if i < 2 else 0.4)
    fx.add(sfx.pop(0.22, 700, 1200), t0 + 0.3, pan=-0.4 if i < 2 else 0.4)
fx.add(sfx.whoosh(0.6, 0.28, up=False, seed=55), T['teamOut'])
fx.add(sfx.whoosh(0.7, 0.3, up=True, seed=56), T['chat'])
for k in ('q1', 'q2', 'q3'):
    fx.add(sfx.msg_in(0.22), T[k], pan=-0.3)
for k in ('fClick', 'fAll', 'tClick', 'ddPick', 'tGo', 'qPick', 'send', 'nClick'):
    fx.add(sfx.click(0.35), T[k])
for k in ('c3', 'c4'):
    fx.add(sfx.whoosh(0.45, 0.12, up=True, seed=57), T[k] - 0.1)
fx.add(sfx.msg_in(0.24), T['m3'])
fx.add(sfx.pop(0.2, 700, 1100), T['tClick'] + 0.1)
fx.add(sfx.success(0.2), T['m4'])
fx.add(sfx.key_tick(1, 0.2), T['slash'])
fx.add(sfx.pop(0.2, 700, 1100), T['slash'] + 0.15)
fx.add(sfx.msg_out(0.28), T['send'])
fx.add(sfx.msg_in(0.3), T['nIn'])
fx.add(sfx.bell(79, 0.8, 0.1), T['nIn'] + 0.05)
fx.add(sfx.success(0.22), T['nClick'] + 0.1)
fx.add(sfx.whoosh(0.6, 0.28, up=False, seed=58), T['chatOut'])

fx.buf += music.buf * 0.8
fx.write('sons_atendimento.wav', DUR, fade_out=1.5)
print('ok → sons_atendimento.wav')
