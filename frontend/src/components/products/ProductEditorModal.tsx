import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, ImageIcon, Link2, Loader2, Plus, Search, Timer, Trash2, Upload, X } from 'lucide-react';
import { api } from '../../api/client';
import type { LibraryFileListItem, Product, ProductPlateFile, ProductWrite } from '../../api/client';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { NumberInput } from '../NumberInput';
import { useToast } from '../../contexts/ToastContext';
import { formatDuration } from '../../utils/date';
import { isSlicedLibraryFile } from '../../utils/libraryFiles';
import { guessPlatePieces } from '../../utils/products';

interface DraftPart {
  id?: number;
  name: string;
  quantity: number;
  matched: boolean;
  finish_minutes: number;
}

interface DraftPlate {
  library_file_id: number;
  plate_id: number | null;
  file: ProductPlateFile;
  /** Pieces per part, by the part's index in the draft. */
  pieces: number[];
}

interface ProductEditorModalProps {
  /** The product to change; none to create one. */
  product?: Product | null;
  onClose: () => void;
}

const inputClass =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white placeholder-bambu-gray text-sm focus:border-bambu-green focus:outline-none';

function draftFrom(product: Product | null | undefined): { parts: DraftPart[]; plates: DraftPlate[] } {
  if (!product) return { parts: [{ name: '', quantity: 1, matched: false, finish_minutes: 0 }], plates: [] };
  const parts = product.parts.map((p) => ({
    id: p.id,
    name: p.name,
    quantity: p.quantity,
    matched: p.matched,
    finish_minutes: p.finish_minutes ?? 0,
  }));
  const plates = product.plates.map((plate) => ({
    library_file_id: plate.library_file_id,
    plate_id: plate.plate_id,
    file: plate.file,
    pieces: product.parts.map((part) => plate.pieces.find((p) => p.part_id === part.id)?.pieces ?? 0),
  }));
  return { parts, plates };
}

/**
 * Fork (products): define a product's parts and the sliced plates that print them.
 *
 * Parts marked "same printer" are printed on one printer for each product (a
 * lid and its base). A plate is a sliced file from the library; its printer
 * model comes from the file, and it may print pieces of several parts.
 */
export function ProductEditorModal({ product, onClose }: ProductEditorModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const initial = useMemo(() => draftFrom(product), [product]);
  const [name, setName] = useState(product?.name ?? '');
  const [notes, setNotes] = useState(product?.notes ?? '');
  const [parts, setParts] = useState<DraftPart[]>(initial.parts);
  const [plates, setPlates] = useState<DraftPlate[]>(initial.plates);
  const [skus, setSkus] = useState<{ sku: string; units: number }[]>(() =>
    (product?.skus ?? []).map((s) => ({ sku: s.sku, units: s.units })),
  );
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A picture picked to upload on save, or the uploaded one to drop.
  const [picture, setPicture] = useState<File | null>(null);
  const [dropPicture, setDropPicture] = useState(false);
  const picturePreview = useMemo(() => (picture ? URL.createObjectURL(picture) : null), [picture]);
  useEffect(() => () => {
    if (picturePreview) URL.revokeObjectURL(picturePreview);
  }, [picturePreview]);
  const shownPicture =
    picturePreview ??
    (product && product.has_thumbnail && !(dropPicture && product.custom_thumbnail)
      ? api.getProductThumbnailUrl(product.id, product.thumbnail_version)
      : null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { data: files, isLoading: filesLoading } = useQuery({
    queryKey: ['library-files', 'products-picker'],
    queryFn: () => api.getLibraryFiles(undefined, false),
    enabled: picking,
  });

  const candidates = useMemo(() => {
    const used = new Set(plates.map((p) => p.library_file_id));
    const needle = search.trim().toLowerCase();
    return (files ?? [])
      .filter((f: LibraryFileListItem) => isSlicedLibraryFile(f) && !used.has(f.id))
      .filter((f) => !needle || `${f.print_name ?? ''} ${f.filename}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.print_name || a.filename).localeCompare(b.print_name || b.filename))
      .slice(0, 100);
  }, [files, plates, search]);

  const saveMutation = useMutation({
    mutationFn: async (data: ProductWrite) => {
      let saved = product ? await api.updateProduct(product.id, data) : await api.createProduct(data);
      if (picture) saved = await api.uploadProductThumbnail(saved.id, picture);
      else if (dropPicture && saved.custom_thumbnail) saved = await api.deleteProductThumbnail(saved.id);
      return saved;
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product', saved.id] });
      showToast(t('products.toast.saved', { name: saved.name }), 'success');
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const addPlate = async (file: LibraryFileListItem) => {
    setAdding(file.id);
    try {
      const info = await api.getProductFileInfo(file.id);
      setPlates((current) => [
        ...current,
        { library_file_id: file.id, plate_id: null, file: info, pieces: guessPlatePieces(parts, info) },
      ]);
      setPicking(false);
      setSearch('');
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setAdding(null);
    }
  };

  const removePart = (index: number) => {
    setParts((current) => current.filter((_, i) => i !== index));
    setPlates((current) => current.map((plate) => ({ ...plate, pieces: plate.pieces.filter((_, i) => i !== index) })));
  };

  const addPart = () => {
    setParts((current) => [...current, { name: '', quantity: 1, matched: false, finish_minutes: 0 }]);
    setPlates((current) => current.map((plate) => ({ ...plate, pieces: [...plate.pieces, 0] })));
  };

  const save = () => {
    setError(null);
    if (!name.trim()) return setError(t('products.editor.errorName'));
    if (!parts.length || parts.some((p) => !p.name.trim())) return setError(t('products.editor.errorPartName'));
    if (plates.some((plate) => !plate.pieces.some((n) => n > 0))) return setError(t('products.editor.errorPlatePieces'));
    saveMutation.mutate({
      name: name.trim(),
      notes: notes.trim() || null,
      parts: parts.map((p) => ({
        id: p.id ?? null,
        name: p.name.trim(),
        quantity: p.quantity,
        matched: p.matched,
        finish_minutes: p.finish_minutes,
      })),
      plates: plates.map((plate) => ({
        library_file_id: plate.library_file_id,
        plate_id: plate.plate_id,
        pieces: plate.pieces.flatMap((n, part) => (n > 0 ? [{ part, pieces: n }] : [])),
      })),
      skus: skus
        .map((s) => ({ sku: s.sku.trim(), units: s.units }))
        .filter((s) => s.sku),
    });
  };

  const partsWithoutPlate = parts.filter((_, index) => !plates.some((plate) => (plate.pieces[index] ?? 0) > 0));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-3xl max-h-[90vh] flex flex-col">
        <CardContent className="p-0 flex flex-col min-h-0">
          <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary shrink-0">
            <div className="flex items-center gap-2">
              <Boxes className="w-5 h-5 text-bambu-green" />
              <h2 className="text-lg font-semibold text-white">
                {product ? t('products.editor.editTitle') : t('products.editor.newTitle')}
              </h2>
            </div>
            <button onClick={onClose} className="text-bambu-gray hover:text-white" aria-label={t('common.close')}>
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-4 space-y-5 overflow-y-auto min-h-0">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="block text-sm text-bambu-gray mb-1">{t('products.editor.name')}</span>
                <input
                  className={inputClass}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('products.editor.namePlaceholder')}
                  autoFocus
                />
              </label>
              <label className="block">
                <span className="block text-sm text-bambu-gray mb-1">{t('products.editor.notes')}</span>
                <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
            </div>

            <section className="flex items-center gap-3">
              <div className="w-16 h-16 rounded-lg bg-bambu-dark border border-bambu-dark-tertiary overflow-hidden flex items-center justify-center shrink-0">
                {shownPicture ? (
                  <img src={shownPicture} alt="" className="w-full h-full object-cover" />
                ) : (
                  <ImageIcon className="w-6 h-6 text-bambu-gray" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white cursor-pointer">
                    <Upload className="w-4 h-4" />
                    {t('products.editor.pictureUpload')}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      aria-label={t('products.editor.pictureUpload')}
                      onChange={(e) => {
                        const chosen = e.target.files?.[0] ?? null;
                        setPicture(chosen);
                        setDropPicture(false);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {(picture || (product?.custom_thumbnail && !dropPicture)) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPicture(null);
                        setDropPicture(true);
                      }}
                    >
                      {t('products.editor.pictureRemove')}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-bambu-gray mt-1">{t('products.editor.pictureHint')}</p>
              </div>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-white mb-1">{t('products.editor.parts')}</h3>
              <p className="text-xs text-bambu-gray mb-2">{t('products.editor.partsHint')}</p>
              <p className="text-xs text-bambu-gray mb-2">{t('products.editor.finishHint')}</p>
              <div className="space-y-2">
                {parts.map((part, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <input
                      className={`${inputClass} flex-1 min-w-[10rem]`}
                      value={part.name}
                      placeholder={t('products.editor.partNamePlaceholder')}
                      aria-label={t('products.editor.partName')}
                      onChange={(e) =>
                        setParts((current) => current.map((p, i) => (i === index ? { ...p, name: e.target.value } : p)))
                      }
                    />
                    <label className="flex items-center gap-1 text-sm text-bambu-gray whitespace-nowrap">
                      {t('products.editor.perProduct')}
                      <NumberInput
                        min={1}
                        max={100}
                        fallback={1}
                        className={`${inputClass} w-20`}
                        value={part.quantity}
                        onChange={(quantity) =>
                          setParts((current) => current.map((p, i) => (i === index ? { ...p, quantity } : p)))
                        }
                      />
                    </label>
                    <label className="flex items-center gap-1.5 text-sm text-bambu-gray" title={t('products.editor.matchedHint')}>
                      <input
                        type="checkbox"
                        checked={part.matched}
                        onChange={(e) =>
                          setParts((current) =>
                            current.map((p, i) => (i === index ? { ...p, matched: e.target.checked } : p)),
                          )
                        }
                      />
                      <Link2 className="w-3.5 h-3.5" />
                      {t('products.editor.matched')}
                    </label>
                    <label
                      className="flex items-center gap-1 text-sm text-bambu-gray whitespace-nowrap"
                      title={t('products.editor.finishHint')}
                    >
                      <Timer className="w-3.5 h-3.5" />
                      {t('products.editor.finish')}
                      <NumberInput
                        min={0}
                        max={10080}
                        fallback={0}
                        className={`${inputClass} w-20`}
                        value={part.finish_minutes}
                        aria-label={t('products.editor.finish')}
                        onChange={(finish_minutes) =>
                          setParts((current) => current.map((p, i) => (i === index ? { ...p, finish_minutes } : p)))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => removePart(index)}
                      disabled={parts.length === 1}
                      className="p-2 text-bambu-gray hover:text-red-400 disabled:opacity-30"
                      aria-label={t('products.editor.removePart')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="mt-2" onClick={addPart}>
                <Plus className="w-4 h-4" />
                {t('products.editor.addPart')}
              </Button>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-white mb-1">{t('products.editor.skus')}</h3>
              <p className="text-xs text-bambu-gray mb-2">{t('products.editor.skusHint')}</p>
              <div className="space-y-2">
                {skus.map((entry, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <input
                      className={`${inputClass} flex-1 min-w-[10rem]`}
                      value={entry.sku}
                      placeholder="AB-9x19.100.B"
                      aria-label={t('products.editor.sku')}
                      onChange={(e) =>
                        setSkus((current) => current.map((s, i) => (i === index ? { ...s, sku: e.target.value } : s)))
                      }
                    />
                    <label className="flex items-center gap-1 text-sm text-bambu-gray whitespace-nowrap">
                      {t('products.editor.skuUnits')}
                      <NumberInput
                        min={1}
                        max={1000}
                        fallback={1}
                        className={`${inputClass} w-20`}
                        value={entry.units}
                        onChange={(units) =>
                          setSkus((current) => current.map((s, i) => (i === index ? { ...s, units } : s)))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setSkus((current) => current.filter((_, i) => i !== index))}
                      className="p-2 text-bambu-gray hover:text-red-400"
                      aria-label={t('products.editor.removeSku')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => setSkus((current) => [...current, { sku: '', units: 1 }])}
              >
                <Plus className="w-4 h-4" />
                {t('products.editor.addSku')}
              </Button>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-white mb-1">{t('products.editor.plates')}</h3>
              <p className="text-xs text-bambu-gray mb-2">{t('products.editor.platesHint')}</p>
              {plates.length > 0 && (
                <div className="space-y-2">
                  {plates.map((plate, plateIndex) => (
                    <div
                      key={plate.library_file_id}
                      className="rounded-lg border border-bambu-dark-tertiary p-3 flex flex-col gap-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm text-white truncate flex-1">
                          {plate.file.print_name || plate.file.filename}
                        </span>
                        {plate.file.model && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-bambu-dark-tertiary text-bambu-gray-light shrink-0">
                            {plate.file.model}
                          </span>
                        )}
                        {plate.file.print_time_seconds ? (
                          <span className="text-xs text-bambu-gray shrink-0">{formatDuration(plate.file.print_time_seconds)}</span>
                        ) : null}
                        {plate.file.missing && (
                          <span className="text-xs text-amber-500 shrink-0">{t('products.editor.fileMissing')}</span>
                        )}
                        <button
                          type="button"
                          onClick={() => setPlates((current) => current.filter((_, i) => i !== plateIndex))}
                          className="p-1 text-bambu-gray hover:text-red-400 shrink-0"
                          aria-label={t('products.editor.removePlate')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        {parts.map((part, partIndex) => (
                          <label key={partIndex} className="flex items-center gap-1.5 text-xs text-bambu-gray">
                            {part.name || t('products.editor.partN', { n: partIndex + 1 })}
                            <NumberInput
                              min={0}
                              max={1000}
                              fallback={0}
                              className={`${inputClass} w-16 py-1`}
                              value={plate.pieces[partIndex] ?? 0}
                              onChange={(value) => {
                                setPlates((current) =>
                                  current.map((p, i) =>
                                    i === plateIndex
                                      ? { ...p, pieces: p.pieces.map((n, j) => (j === partIndex ? value : n)) }
                                      : p,
                                  ),
                                );
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {partsWithoutPlate.length > 0 && plates.length > 0 && (
                <p className="text-xs text-amber-500 mt-2">
                  {t('products.editor.partsWithoutPlate', { parts: partsWithoutPlate.map((p) => p.name).join(', ') })}
                </p>
              )}
              {picking ? (
                <div className="mt-3 rounded-lg border border-bambu-dark-tertiary p-3">
                  <div className="relative mb-2">
                    <Search className="w-4 h-4 text-bambu-gray absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      className={`${inputClass} pl-9`}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder={t('products.editor.searchFiles')}
                      autoFocus
                    />
                  </div>
                  {filesLoading ? (
                    <div className="flex justify-center py-4">
                      <Loader2 className="w-5 h-5 animate-spin text-bambu-gray" />
                    </div>
                  ) : candidates.length === 0 ? (
                    <p className="text-sm text-bambu-gray py-2">{t('products.editor.noFiles')}</p>
                  ) : (
                    <ul className="max-h-60 overflow-y-auto divide-y divide-bambu-dark-tertiary">
                      {candidates.map((file) => (
                        <li key={file.id}>
                          <button
                            type="button"
                            onClick={() => addPlate(file)}
                            disabled={adding !== null}
                            className="w-full flex items-center gap-2 py-2 px-1 text-left hover:bg-bambu-dark-tertiary rounded disabled:opacity-50"
                          >
                            <span className="text-sm text-white truncate flex-1">{file.print_name || file.filename}</span>
                            {file.sliced_for_model && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-bambu-dark-tertiary text-bambu-gray-light">
                                {file.sliced_for_model}
                              </span>
                            )}
                            {file.print_time_seconds ? (
                              <span className="text-xs text-bambu-gray">{formatDuration(file.print_time_seconds)}</span>
                            ) : null}
                            {adding === file.id && <Loader2 className="w-4 h-4 animate-spin text-bambu-gray" />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex justify-end mt-2">
                    <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="secondary" size="sm" className="mt-2" onClick={() => setPicking(true)}>
                  <Plus className="w-4 h-4" />
                  {t('products.editor.addPlate')}
                </Button>
              )}
            </section>

            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 p-4 border-t border-bambu-dark-tertiary shrink-0">
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={save} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
