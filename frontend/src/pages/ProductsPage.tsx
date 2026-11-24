import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, ShoppingBag } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ProductsView } from '../components/products/ProductsView';
import { BaseOrdersView } from '../components/products/BaseOrdersView';

type Tab = 'products' | 'base';

function initialTab(): Tab {
  const url = new URLSearchParams(window.location.search).get('tab');
  if (url === 'base' || url === 'products') return url;
  try {
    return localStorage.getItem('products.activeTab') === 'base' ? 'base' : 'products';
  } catch {
    return 'products';
  }
}

/**
 * Fork (products): products made of parts and their orders, on their own page;
 * orders from Base (base.com) in the second tab. See components/products.
 */
export function ProductsPage() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState<Tab>(initialTab);

  const choose = (next: Tab) => {
    setTab(next);
    try {
      localStorage.setItem('products.activeTab', next);
    } catch {
      // a private window: the tab is just not remembered
    }
  };

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <Boxes className="w-7 h-7 text-bambu-green" />
          {t('products.title')}
        </h1>
        <p className="text-bambu-gray mt-1">{t('products.subtitle')}</p>
      </div>
      <div className="flex gap-1 border-b border-bambu-dark-tertiary mb-6 overflow-x-auto" role="tablist">
        {([
          { id: 'products' as const, label: t('products.tabs.products'), icon: Boxes },
          { id: 'base' as const, label: t('products.tabs.base'), icon: ShoppingBag },
        ]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => choose(id)}
            className={`px-4 py-2.5 text-sm flex items-center gap-2 border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === id ? 'text-white border-bambu-green font-medium' : 'text-bambu-gray border-transparent hover:text-white'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>
      {tab === 'products' ? (
        <ProductsView hasPermission={hasPermission} />
      ) : (
        <BaseOrdersView hasPermission={hasPermission} />
      )}
    </div>
  );
}
