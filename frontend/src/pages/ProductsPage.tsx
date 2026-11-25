import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ProductsView } from '../components/products/ProductsView';

/**
 * Fork (products): products made of parts and their orders, on their own page.
 * Orders from Base and the prints to check have their own page (OrdersPage);
 * old links to their tabs here (?tab=base, ?tab=qc) go there.
 */
export function ProductsPage() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const search = new URLSearchParams(window.location.search);
  const tab = search.get('tab');
  if (tab === 'base' || tab === 'qc') {
    search.delete('tab');
    if (tab === 'qc') search.set('tab', 'qc');
    const query = search.toString();
    return <Navigate to={`/orders${query ? `?${query}` : ''}`} replace />;
  }

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <Boxes className="w-7 h-7 text-bambu-green" />
          {t('products.title')}
        </h1>
        <p className="text-bambu-gray mt-1">{t('products.subtitle')}</p>
      </div>
      <ProductsView hasPermission={hasPermission} />
    </div>
  );
}
