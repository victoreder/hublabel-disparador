"""Trilha e efeitos de anuncio-disparos.html (tempos espelham o objeto T do HTML)."""
import sfx
from sfx import Mix

DUR = 28.0
T = dict(
    hookOut=2.7, app=2.95, map=3.7, cont=5.6,
    lista=5.8, c2=7.8, prox=9.3, tpl=9.4,
    c3=13.0, ed=13.0, s1=13.6, s2=15.1, s3=16.6,
    c4=18.6, det=18.6, count=19.0, countEnd=20.6, desce=21.6,
    appOut=24.3, end=24.55,
)
music = sfx.groove(DUR, T['app'], T['end'])
fx = Mix(DUR)
sfx.standard_open_close(fx, T['hookOut'], T['app'], T['end'])

for i in range(5):
    fx.add(sfx.click(0.22), T['map'] + i * 0.3)
    fx.add(sfx.pop(0.12, 900 + i * 120, 1300 + i * 120), T['map'] + i * 0.3 + 0.03)
fx.add(sfx.click(0.4), T['cont'])
fx.add(sfx.whoosh(0.5, 0.18, up=True, seed=21), T['lista'] - 0.1)
fx.add(sfx.success(0.2), T['lista'] + 0.4)
for k in ('c2', 'c3', 'c4'):
    fx.add(sfx.whoosh(0.55, 0.22, up=True, seed=22), T[k] - 0.1)
fx.add(sfx.click(0.4), T['prox'])
fx.add(sfx.pop(0.25, 600, 1100), T['tpl'] + 0.3)
fx.add(sfx.msg_in(0.22), T['tpl'] + 0.4)
for k in ('s1', 's2', 's3'):
    fx.add(sfx.whoosh(0.45, 0.12, up=True, seed=30), T[k] - 0.4)
    fx.add(sfx.pop(0.24, 700, 1200), T[k] + 0.1)
fx.add(sfx.riser(1.6, 0.1), T['count'])
for i in range(16):
    fx.add(sfx.key_tick(i, 0.1), T['count'] + i * 0.1)
fx.add(sfx.success(0.24), T['countEnd'])
fx.add(sfx.whoosh(0.6, 0.14, up=False, seed=31), T['desce'])
fx.add(sfx.whoosh(0.6, 0.28, up=False, seed=27), T['appOut'])

fx.buf += music.buf * 0.8
fx.write('sons_disparos.wav', DUR, fade_out=1.5)
print('ok → sons_disparos.wav')
