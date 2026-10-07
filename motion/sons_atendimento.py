"""Trilha e efeitos de anuncio-atendimento.html (tempos espelham o objeto T do HTML)."""
import sfx
from sfx import Mix

DUR = 29.0
T = dict(
    hookOut=2.7, team=2.95, teamOut=7.9,
    chat=8.15, tabAg=9.0, filt=10.2, fin=11.1,
    c3=12.4, menu=12.9, edit=14.0, pick=14.9, transf=15.8,
    c4=17.4, slash=17.9, qPick=18.9, send=19.7,
    c5=20.9, ia=21.0, nIn=21.6, open=23.4, assumiu=24.2, chatOut=25.55,
    end=25.8,
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
for k in ('tabAg', 'filt', 'fin', 'menu', 'edit', 'pick', 'transf', 'slash', 'qPick', 'send', 'open', 'assumiu'):
    fx.add(sfx.click(0.35), T[k])
for k in ('c3', 'c4', 'c5'):
    fx.add(sfx.whoosh(0.45, 0.12, up=True, seed=57), T[k] - 0.1)
fx.add(sfx.success(0.2), T['transf'] + 0.15)
fx.add(sfx.pop(0.2, 700, 1100), T['slash'] + 0.1)
fx.add(sfx.msg_out(0.28), T['send'] + 0.05)
fx.add(sfx.msg_in(0.3), T['nIn'])
fx.add(sfx.bell(79, 0.8, 0.1), T['nIn'] + 0.05)
fx.add(sfx.msg_out(0.28), T['assumiu'] + 0.05)
fx.add(sfx.whoosh(0.6, 0.28, up=False, seed=58), T['chatOut'])

fx.buf += music.buf * 0.8
fx.write('sons_atendimento.wav', DUR, fade_out=1.5)
print('ok → sons_atendimento.wav')
