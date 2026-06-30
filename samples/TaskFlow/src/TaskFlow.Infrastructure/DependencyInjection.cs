using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TaskFlow.Application.Common.Interfaces;
using TaskFlow.Infrastructure.Persistence;

namespace TaskFlow.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructureServices(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("DefaultConnection")
            ?? "Data Source=taskflow.db";

        services.AddDbContext<TaskFlowDbContext>(options =>
            options.UseSqlite(connectionString));

        services.AddScoped<ITaskFlowDbContext>(
            provider => provider.GetRequiredService<TaskFlowDbContext>());

        services.AddScoped<TaskFlowDbContextInitialiser>();

        return services;
    }
}
