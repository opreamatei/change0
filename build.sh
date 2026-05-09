mkdir build
cd build
clear
cmake -DGGML_CUDA=ON -G Ninja ..

if [ -f ./.env ]; then
	echo "Setting ./.env"
	set -a
	source .env
	set +a
fi

cd ..
cmake --build build -j

cd build

./change
