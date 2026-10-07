"""Trilha e efeitos de anuncio-disparos.html (tempos espelham o objeto T do HTML)."""
import sfx
from sfx import Mix

DUR = 27.0
T = dict(
    hookOut=2.7,
    wzIn=2.95, fileIn=3.5, drop=4.3, rows=4.6, verify=5.6, verifyEnd=7.3, next1=7.9,
    tpl=8.2, s1=8.6, v1=8.95, s2=9.05, v2=9.4, s3=9.5, v3=10.55, s4=10.65, btn1=11.15, btn2=11.35, resolve=11.8, wzOut=13.0,
    send=13.25, burst=13.9, burstEnd=17.2, abIn=15.5, sendOut=18.45,
    rep=18.6, kpi=19.1, kpiEnd=21.0, replies=20.3, repOut=23.55,
    end=23.8,
)
music = sfx.groove(DUR, T['wzIn'], T['end'])
fx = Mix(DUR)
sfx.standard_open_close(fx, T['hookOut'], T['wzIn'], T['end'])

fx.add(sfx.whoosh(0.6, 0.16, up=True, seed=21), T['fileIn'])
fx.add(sfx.impact(0.25), T['drop'])
fx.add(sfx.pop(0.25, 500, 900), T['drop'])
for i in range(4):
    fx.add(sfx.pop(0.1, 1000 + i * 120, 1300 + i * 120), T['rows'] + i * 0.12)
fx.add(sfx.tick_tock(14, 0.11, 0.08), T['verify'])
fx.add(sfx.success(0.18), T['verifyEnd'])
fx.add(sfx.click(0.35), T['next1'])
fx.add(sfx.whoosh(0.5, 0.18, up=True, seed=22), T['tpl'] - 0.1)
for k, n in (('s1', 3), ('s2', 4), ('s3', 34), ('s4', 17)):
    fx.add(sfx.typing(n / 48, cps=26, gain=0.12, seed=sum(map(ord, k))), T[k], pan=0.1)
for k in ('v1', 'v2', 'v3', 'btn1', 'btn2'):
    fx.add(sfx.pop(0.28, 500, 950), T[k])
for i in range(3):
    fx.add(sfx.bell(84 + i * 3, 0.6, 0.08), T['resolve'] + i * 0.15)
fx.add(sfx.whoosh(0.6, 0.28, up=False, seed=23), T['wzOut'])

fx.add(sfx.whoosh(0.7, 0.3, up=True, seed=24), T['send'])
# rajada de envios: um "tic" por partícula, espalhado
for i in range(104):
    ord_ = (i * 37) % 104
    t0 = T['burst'] + (ord_ / 104) * (T['burstEnd'] - T['burst'] - 0.6) + 0.45
    fx.add(sfx.pop(0.05, 1500 + (i % 7) * 90, 1900 + (i % 7) * 90), t0, pan=0.2 + (i % 13) / 26)
fx.add(sfx.riser(3.0, 0.1), T['burst'])
for i in range(4):
    fx.add(sfx.pop(0.16, 800 + i * 150, 1200 + i * 150), T['abIn'] + i * 0.15)
fx.add(sfx.whoosh(0.6, 0.28, up=False, seed=25), T['sendOut'])

fx.add(sfx.whoosh(0.7, 0.3, up=True, seed=26), T['rep'])
fx.add(sfx.riser(2.0, 0.08), T['kpi'])
fx.add(sfx.success(0.22), T['kpiEnd'] + 0.6)
for i in range(4):
    fx.add(sfx.msg_in(0.2), T['replies'] + i * 0.45, pan=0.3)
fx.add(sfx.whoosh(0.6, 0.28, up=False, seed=27), T['repOut'])

fx.buf += music.buf * 0.8
fx.write('sons_disparos.wav', DUR, fade_out=1.5)
print('ok → sons_disparos.wav')
