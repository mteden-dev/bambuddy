import { useAuth } from '../contexts/AuthContext';
import { ProductsView } from '../components/products/ProductsView';

/**
 * Fork (products): products made of parts and their orders, on their own page
 * so order syncing (a shop) can grow here. See components/products.
 */
export function ProductsPage() {
  const { hasPermission } = useAuth();
  return (
    <div className="p-4 md:p-8">
      <ProductsView hasPermission={hasPermission} />
    </div>
  );
}
