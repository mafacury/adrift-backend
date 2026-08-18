/**
 * CAPTCHA no cadastro — Cloudflare Turnstile.
 *
 * O problema que ele resolve é estreito e específico: criar conta no Adrift não
 * custa nada. Sem CAPTCHA, um script faz mil contas em minutos, e cada conta é
 * uma licença nova para despejar propaganda. O limite de taxa por IP ajuda, mas
 * cai diante de qualquer proxy rotativo; o CAPTCHA cobra por tentativa.
 *
 * Escolhi Turnstile por três motivos: é gratuito sem teto prático, não mostra
 * quebra-cabeça de semáforo para o usuário (na maioria das vezes é invisível), e
 * a verificação é uma chamada HTTPS — sem biblioteca nova no projeto.
 *
 * Mesma porta de duas saídas do mail.ts:
 *
 *   COM `TURNSTILE_SECRET`  verifica de verdade; sem token válido, não cadastra.
 *   SEM a chave             deixa passar, e o servidor avisa no boot que a
 *                           porta está aberta. É o que mantém o
 *                           desenvolvimento andando sem conta na Cloudflare.
 *
 * PARA LIGAR:
 *   1. cloudflare.com → Turnstile → adicionar site (domínio adriftapp.fun)
 *   2. copiar as duas chaves: a pública (site key) e a secreta
 *   3. no Railway:  TURNSTILE_SECRET=0x4AAA...
 *   4. no cliente:  a site key em mobile/app/(auth)/register.tsx
 *
 * ATENÇÃO ao ligar: o widget do Turnstile é web. O aplicativo Android
 * empacotado não tem como gerar o token, então ligar a chave secreta hoje
 * bloqueia o cadastro pelo APK. Enquanto o cadastro real acontecer no site,
 * tudo bem — mas é uma decisão consciente, não um detalhe.
 */
import { config } from '../config/index.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function captchaLigado(): boolean {
  return !!config.antispam.turnstileSecret;
}

/**
 * `true` = pode seguir. Sem chave configurada, sempre `true`.
 *
 * Erro de rede na Cloudflare também devolve `true` — de propósito. A alternativa
 * é derrubar o cadastro do app inteiro toda vez que um serviço de terceiro
 * espirra, e o CAPTCHA é uma camada a mais, não a única: quem passar por aqui
 * ainda enfrenta o limite de taxa, a moderação e o banimento por histórico.
 */
export async function verificarCaptcha(
  token: string | undefined,
  ip: string,
): Promise<boolean> {
  const segredo = config.antispam.turnstileSecret;
  if (!segredo) return true;

  if (!token) {
    console.log('[captcha] cadastro sem token — recusado');
    return false;
  }

  try {
    const corpo = new URLSearchParams({
      secret: segredo,
      response: token,
      remoteip: ip,
    });

    // 5 segundos: o cadastro não pode ficar pendurado esperando a Cloudflare.
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: corpo,
      signal: AbortSignal.timeout(5000),
    });

    const dados = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (!dados.success) {
      console.log(`[captcha] recusado: ${(dados['error-codes'] ?? []).join(', ') || 'sem motivo'}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[captcha] verificação falhou — deixando passar:', err);
    return true;
  }
}
