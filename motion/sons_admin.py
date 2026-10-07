"""Trilha e efeitos de anuncio-admin.html (tempos espelham o objeto T do HTML)."""
import sfx
from sfx import Mix

DUR = 35.0
T = dict(
    hookOut=2.8, app=3.05, count=3.6, countEnd=5.4,
    c2=7.4, cli=7.4, menu=9.0, mudar=10.3, aplicar=11.5,
    c3=12.8, planos=12.8, novo=15.2, c4=16.6, limites=17.0,
    c5=20.2, pers=20.2, nome=20.8, cor=21.9, logo=22.8, suporte=23.6,
    c6=24.9, emails=24.9, assunto=25.5,
    c7=27.4, url=27.6, login=28.6, crm=30.0, appOut=31.6,
    end=31.85,
)
music = sfx.groove(DUR, T['app'], T['end'])
fx = Mix(DUR)
sfx.standard_open_close(fx, T['hookOut'], T['app'], T['end'])

fx.add(sfx.riser(1.8, 0.1), T['count'])
for i in range(18):
    fx.add(sfx.key_tick(i, 0.09), T['count'] + i * 0.1)
fx.add(sfx.success(0.2), T['countEnd'])
for k in ('c2', 'c3', 'c4', 'c5', 'c6', 'c7'):
    fx.add(sfx.whoosh(0.5, 0.18, up=True, seed=60), T[k] - 0.1)
for k in ('menu', 'mudar', 'aplicar', 'novo'):
    fx.add(sfx.click(0.38), T[k])
fx.add(sfx.success(0.2), T['aplicar'] + 0.1)
fx.add(sfx.typing(0.6, cps=22, gain=0.12, seed=1), T['novo'] + 0.3)
fx.add(sfx.typing(0.4, cps=10, gain=0.12, seed=2), T['novo'] + 0.75)
fx.add(sfx.whoosh(0.6, 0.12, up=False, seed=61), T['limites'] - 0.4)
fx.add(sfx.typing(1.8, cps=12, gain=0.1, seed=3), T['limites'] + 0.5)
fx.add(sfx.typing(0.7, cps=16, gain=0.12, seed=4), T['nome'])
fx.add(sfx.typing(0.5, cps=14, gain=0.12, seed=5), T['cor'])
fx.add(sfx.pop(0.28, 600, 1100), T['logo'])
fx.add(sfx.pop(0.22, 800, 1300), T['logo'] + 0.3)
fx.add(sfx.typing(0.5, cps=26, gain=0.1, seed=6), T['suporte'])
fx.add(sfx.typing(1.3, cps=24, gain=0.12, seed=7), T['assunto'])
fx.add(sfx.typing(0.8, cps=22, gain=0.14, seed=8), T['url'])
fx.add(sfx.whoosh(0.5, 0.2, up=True, seed=62), T['login'] - 0.1)
fx.add(sfx.whoosh(0.5, 0.2, up=True, seed=63), T['crm'] - 0.1)
fx.add(sfx.sparkle(0.14), T['crm'] + 0.3)
fx.add(sfx.whoosh(0.6, 0.28, up=False, seed=64), T['appOut'])

fx.buf += music.buf * 0.8
fx.write('sons_admin.wav', DUR, fade_out=1.5)
print('ok → sons_admin.wav')
