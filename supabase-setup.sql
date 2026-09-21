create table if not exists public.products (
  id text primary key,
  name text not null,
  collection text not null default 'kids',
  category text not null,
  age text default '',
  size text default '',
  price numeric not null,
  stock integer not null default 50,
  images text[] not null default '{}',
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.products add column if not exists name text;
alter table public.products add column if not exists collection text default 'kids';
alter table public.products add column if not exists category text;
alter table public.products add column if not exists age text default '';
alter table public.products add column if not exists size text default '';
alter table public.products add column if not exists price numeric;
alter table public.products add column if not exists stock integer default 50;
alter table public.products add column if not exists images text[] default '{}';
alter table public.products add column if not exists tags text[] default '{}';
alter table public.products add column if not exists created_at timestamptz default now();
alter table public.products add column if not exists updated_at timestamptz default now();

create table if not exists public.orders (
  id text primary key,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  status text not null default 'received',
  customer jsonb not null default '{}',
  items jsonb not null default '[]',
  subtotal numeric not null default 0,
  shipping numeric not null default 0,
  total numeric not null default 0
);

alter table public.orders add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.orders add column if not exists created_at timestamptz default now();
alter table public.orders add column if not exists status text default 'received';
alter table public.orders add column if not exists customer jsonb default '{}';
alter table public.orders add column if not exists items jsonb default '[]';
alter table public.orders add column if not exists subtotal numeric default 0;
alter table public.orders add column if not exists shipping numeric default 0;
alter table public.orders add column if not exists total numeric default 0;

alter table public.products enable row level security;
alter table public.orders enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.products to anon, authenticated;
grant insert on public.orders to anon, authenticated;
grant select, insert, update on public.products to authenticated;
grant select, update on public.orders to authenticated;

create or replace function public.is_myeonn_admin()
returns boolean
language sql
stable
as $$
  select auth.uid() = 'a1592343-bf1f-43dc-a62c-88f1dea87465'::uuid
    or lower(coalesce(auth.email(), '')) in ('admin@myeonn.com', 'myeonnadmin@gmail.com');
$$;

create or replace function public.create_myeonn_order(order_payload jsonb)
returns setof public.orders
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  insert into public.orders (
    id,
    user_id,
    created_at,
    status,
    customer,
    items,
    subtotal,
    shipping,
    total
  )
  values (
    coalesce(order_payload->>'id', 'MYN-' || upper(substr(gen_random_uuid()::text, 1, 8))),
    nullif(order_payload->>'user_id', '')::uuid,
    coalesce((order_payload->>'created_at')::timestamptz, now()),
    coalesce(order_payload->>'status', 'received'),
    coalesce(order_payload->'customer', '{}'::jsonb),
    coalesce(order_payload->'items', '[]'::jsonb),
    coalesce((order_payload->>'subtotal')::numeric, 0),
    coalesce((order_payload->>'shipping')::numeric, 0),
    coalesce((order_payload->>'total')::numeric, 0)
  )
  returning *;
end;
$$;

grant execute on function public.create_myeonn_order(jsonb) to anon, authenticated;

drop policy if exists "Public can read products" on public.products;
create policy "Public can read products"
on public.products for select
using (true);

drop policy if exists "Admin can create products" on public.products;
create policy "Admin can create products"
on public.products for insert
with check (public.is_myeonn_admin());

drop policy if exists "Admin can update products" on public.products;
create policy "Admin can update products"
on public.products for update
using (public.is_myeonn_admin())
with check (public.is_myeonn_admin());

drop policy if exists "Public can create orders" on public.orders;
create policy "Public can create orders"
on public.orders for insert
to anon, authenticated
with check (true);

drop policy if exists "Admin can read orders" on public.orders;
create policy "Admin can read orders"
on public.orders for select
using (public.is_myeonn_admin());

drop policy if exists "Admin can update orders" on public.orders;
create policy "Admin can update orders"
on public.orders for update
using (public.is_myeonn_admin())
with check (public.is_myeonn_admin());

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Public can read product images" on storage.objects;
create policy "Public can read product images"
on storage.objects for select
using (bucket_id = 'product-images');

drop policy if exists "Admin can upload product images" on storage.objects;
create policy "Admin can upload product images"
on storage.objects for insert
with check (
  bucket_id = 'product-images'
  and public.is_myeonn_admin()
);

drop policy if exists "Admin can update product images" on storage.objects;
create policy "Admin can update product images"
on storage.objects for update
using (
  bucket_id = 'product-images'
  and public.is_myeonn_admin()
)
with check (
  bucket_id = 'product-images'
  and public.is_myeonn_admin()
);
