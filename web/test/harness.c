/* Differential test oracle: runs one random instruction on EXORsim's 6800 core. */
#include <stdio.h>
#include <stdlib.h>
#include <setjmp.h>
#include "sim6800.h"
static jmp_buf jb; static int calls; static unsigned seed;
static unsigned short waddr[8]; static unsigned char wval[8]; static int nw;
static unsigned char over[65536]; static unsigned char has[65536];
static unsigned hash(unsigned s, unsigned a){unsigned h=s^(a*0x9E3779B1u);h^=h>>16;h*=0x85EBCA6Bu;h^=h>>13;h*=0xC2B2AE35u;h^=h>>16;return h;}
unsigned char mread(unsigned short a){return has[a]?over[a]:(hash(seed,a)&0xFF);}
void mwrite(unsigned short a,unsigned char d){if(nw<8){waddr[nw]=a;wval[nw]=d;}nw++;over[a]=d;has[a]=1;}
void jump(unsigned short a){pc=a;}
void monitor(void){ if(calls++) longjmp(jb,1); }
/* stubs EXORsim's other files would provide */

FILE *mon_out;
int main(int argc,char**argv){
  int N=atoi(argv[1]); mon_out=stdout;
  static const unsigned char def[256]={
  0,1,0,0,0,0,1,1,1,1,1,1,1,1,1,1, 1,1,0,0,0,0,1,1,0,1,0,1,0,0,0,0,
  1,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,1,1,1,1,1,0,1,0,1,0,0,0,1,
  1,0,0,1,1,0,1,1,1,1,1,0,1,1,0,1, 1,0,0,1,1,0,1,1,1,1,1,0,1,1,0,1,
  1,0,0,1,1,0,1,1,1,1,1,0,1,1,1,1, 1,0,0,1,1,0,1,1,1,1,1,0,1,1,1,1,
  1,1,1,0,1,1,1,0,1,1,1,1,1,1,1,0, 1,1,1,0,1,1,1,1,1,1,1,1,1,0,1,1,
  1,1,1,0,1,1,1,1,1,1,1,1,1,1,1,1, 1,1,1,0,1,1,1,1,1,1,1,1,1,1,1,1,
  1,1,1,0,1,1,1,0,1,1,1,1,0,0,1,0, 1,1,1,0,1,1,1,1,1,1,1,1,0,0,1,1,
  1,1,1,0,1,1,1,1,1,1,1,1,0,0,1,1, 1,1,1,0,1,1,1,1,1,1,1,1,0,0,1,1};
  for(int i=0;i<N;i++){
    seed=(unsigned)i*2654435761u+1u; unsigned r=hash(seed,0x12345);
    for(int k=0;k<65536;k++)has[k]=0;
    unsigned op; int t=0; do{op=hash(seed,0x777+t++)&0xFF;}while(!def[op]);
    pc=hash(seed,1)&0xFFFF; acca=hash(seed,2); accb=hash(seed,3); ix=hash(seed,4); sp=hash(seed,5);
    write_flags(hash(seed,6)&0x3F);
    over[pc]=op; has[pc]=1;
    nw=0; calls=0; stop=1;
    if(!setjmp(jb)) sim();
    stop=1;
    printf("%d %02X %04X %02X %02X %04X %04X %02X %d",i,op,pc,acca,accb,ix,sp,read_flags()&0x3F,nw);
    for(int k=0;k<nw&&k<8;k++)printf(" %04X:%02X",waddr[k],wval[k]);
    printf("\n"); (void)r;
  }
  return 0;
}
