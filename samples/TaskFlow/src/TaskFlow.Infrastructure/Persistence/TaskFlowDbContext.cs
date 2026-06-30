using Microsoft.EntityFrameworkCore;
using System.Reflection;
using TaskFlow.Application.Common.Interfaces;
using TaskFlow.Domain.Entities;

namespace TaskFlow.Infrastructure.Persistence;

public class TaskFlowDbContext(DbContextOptions<TaskFlowDbContext> options)
    : DbContext(options), ITaskFlowDbContext
{
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<AppTask> Tasks => Set<AppTask>();
    public DbSet<Tag> Tags => Set<Tag>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(Assembly.GetExecutingAssembly());
        base.OnModelCreating(modelBuilder);
    }
}
