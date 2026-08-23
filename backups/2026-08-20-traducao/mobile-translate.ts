/**
 * Tradução das mensagens de um barco — compartilhada pelas duas telas.
 *
 * A Jornada e o Mapa mostram as mesmas mensagens montadas de formas diferentes
 * (uma vem da fila de recebimento, a outra dos pulos do barco), então a
 * tradução é casada pelo TEXTO ORIGINAL, não pela posição na lista. Assim cada
 * tela acha a sua sem depender de ordem.
 *
 * Nunca é automática: só quando a pessoa pede. E o original nunca é jogado
 * fora — o botão alterna entre os dois, porque a mensagem que alguém escreveu
 * é a mensagem; a tradução é ajuda para entender.
 */
import { useCallback, useState } from 'react';
import { apiPost } from './api';
import { t } from './i18n';

export interface Traducao { texto: string; origem: string }

interface Resposta {
  translations: { original: string; texto: string; origem: string }[];
}

export function useTraducao(boatId: string | null | undefined) {
  const [mapa, setMapa]   = useState<Map<string, Traducao> | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [vendo, setVendo] = useState(false);

  /** Zera ao trocar de barco: a tradução é daquele barco, não da tela. */
  const limpar = useCallback(() => { setMapa(null); setVendo(false); }, []);

  /**
   * Primeiro toque busca e mostra; os seguintes só alternam.
   * Devolve uma mensagem de erro quando falha, ou null quando deu certo.
   */
  const alternar = useCallback(async (): Promise<string | null> => {
    if (!boatId) return null;
    if (mapa) { setVendo(v => !v); return null; }

    setOcupado(true);
    try {
      const d = await apiPost<Resposta>(`/boats/${boatId}/translate`, {});
      const lista = d.translations ?? [];
      // Lista vazia é falha, não resultado: sem isto o botão viraria "Ver
      // original" e a tela não mudaria nada — a pior forma de erro, a que não
      // se anuncia. E não guardamos o vazio, senão o toque seguinte apenas
      // alternaria um estado que não existe.
      if (lista.length === 0) return t('Não foi possível traduzir agora. Tente de novo em instantes.');

      const m = new Map<string, Traducao>();
      for (const t of lista) m.set(t.original, { texto: t.texto, origem: t.origem });
      setMapa(m);
      setVendo(true);
      return null;
    } catch (e: any) {
      return e?.message ?? t('Não foi possível traduzir agora.');
    } finally {
      setOcupado(false);
    }
  }, [boatId, mapa]);

  /** A tradução de um texto, ou undefined quando se está vendo o original. */
  const de = useCallback(
    (original: string): Traducao | undefined => (vendo ? mapa?.get(original) : undefined),
    [vendo, mapa],
  );

  return { alternar, limpar, de, ocupado, vendo };
}
