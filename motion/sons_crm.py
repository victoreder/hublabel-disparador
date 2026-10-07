"""Trilha e efeitos de anuncio-crm.html (tempos espelham o objeto T do HTML)."""
import sfx
from sfx import Mix

DUR = 27.0
T = dict(
    hookOut=2.7, appIn=2.95, cascade=3.4,
    wf1=4.8, new1=5.6, wf2=6.0, new2=6.8,
    c2=8.4, mv1=8.9, mv2=10.0, mv3=11.1, mv4=12.2,
    c3=13.6, idle=14.0, fu=15.0, reply=16.3, mv5=17.3,
    c4=18.6, click=19.1, drawer=19.25, ev=19.8, appOut=23.55,
    end=23.8,
)
music = sfx.groove(DUR, T['appIn'], T['end'])
fx = Mix(DUR)
sfx.standard_open_close(fx, T['hookOut'], T['appIn'], T['end'])

for i in range(8):
    fx.add(sfx.pop(0.08, 900 + i * 80, 1200 + i * 80), T['cascade'] + i * 0.08)
for k, n in (('wf1', 'new1'), ('wf2', 'new2')):
    fx.add(sfx.msg_in(0.24), T[k])
    fx.add(sfx.pop(0.28, 500, 900), T[n])
for k in ('c2', 'c3', 'c4'):
    fx.add(sfx.whoosh(0.45, 0.12, up=True, seed=30), T[k] - 0.1)
for k in ('mv1', 'mv2', 'mv3', 'mv4', 'mv5'):
    fx.add(sfx.msg_in(0.14), T[k] - 0.55)
    fx.add(sfx.whoosh(0.6, 0.16, up=True, seed=40), T[k], pan=0.3)
    fx.add(sfx.click(0.28), T[k] + 0.7, pan=0.3)
fx.add(sfx.tick_tock(8, 0.12, 0.12), T['idle'])
fx.add(sfx.msg_in(0.24), T['fu'] + 0.15)
fx.add(sfx.msg_out(0.26), T['reply'])
fx.add(sfx.success(0.26), T['mv5'] + 0.4)
fx.add(sfx.sparkle(0.14), T['mv5'] + 0.45)
fx.add(sfx.click(0.4), T['click'])
fx.add(sfx.whoosh(0.5, 0.2, up=True, seed=41), T['drawer'])
for i in range(5):
    fx.add(sfx.pop(0.12, 900 + i * 120, 1300 + i * 120), T['ev'] + i * 0.35)
fx.add(sfx.whoosh(0.6, 0.28, up=False, seed=42), T['appOut'])

fx.buf += music.buf * 0.8
fx.write('sons_crm.wav', DUR, fade_out=1.5)
print('ok → sons_crm.wav')
