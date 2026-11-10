import json, sys, numpy as np
from PIL import Image
def lum(c):
    c = c/255.0; c = np.where(c <= 0.03928, c/12.92, ((c+0.055)/1.055)**2.4)
    return 0.2126*c[...,0]+0.7152*c[...,1]+0.0722*c[...,2]
def ratio(a,b):
    hi,lo=np.maximum(a,b),np.minimum(a,b); return (hi+0.05)/(lo+0.05)
for skin in ['graphite','ivory']:
    T=np.asarray(Image.open(f'{skin}-text.png').convert('RGB')).astype(float)
    N=np.asarray(Image.open(f'{skin}-notext.png').convert('RGB')).astype(float)
    d=json.load(open(f'{skin}-boxes.json')); H,W=T.shape[:2]
    res=[]
    for b in d['boxes']:
        x0,y0=b['x'],b['y']; x1,y1=min(W,x0+b['w']),min(H,y0+b['h'])
        if x1-x0<2 or y1-y0<2: continue
        t=T[y0:y1,x0:x1].reshape(-1,3); n=N[y0:y1,x0:x1].reshape(-1,3)
        bgl=np.median(lum(n)); diff=np.abs(t-n).sum(1)
        ink=t[diff>40]
        if len(ink)<4: continue
        r=ratio(lum(ink),bgl); res.append((float(np.percentile(r,95)),b['t'],b['sel'],b['fs']))
    res.sort()
    fails=[r for r in res if r[0]<4.5]
    print(f'== {skin}: text elements measured {len(res)}, min {res[0][0]:.2f}, median {np.median([r[0] for r in res]):.2f}, below 4.5: {len(fails)}')
    for r in fails[:25]: print('   %.2f  %-26s %-22s %spx'%r)
    L=lum(N); out=[]
    for l in d['lines']:
        x,y=l['x'],l['y']
        if not(3<=y<H-6 and 0<=x<W): continue
        border=L[y:y+l['bw']+1,x]; bpx=border[np.argmax(np.abs(border-L[y-2,x]))]
        out.append((float(ratio(bpx,L[y-2,x])),l['sel']))
    out.sort(); lf=[o for o in out if o[0]<3.0]
    print(f'   lines measured {len(out)}, min {out[0][0]:.2f}, below 3.0: {len(lf)}', sorted(set(o[1] for o in lf))[:12])
